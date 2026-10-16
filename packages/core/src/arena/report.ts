import {
  type ArenaCandidateSummary,
  type PromotionProposal,
  paretoFrontier,
  proposePromotion,
} from "./promotion.js";
import {
  bradleyTerry,
  headToHead,
  type PairwiseJudgment,
  type PairwiseOutcome,
  type RankedCandidate,
  reconcileJudgments,
} from "./ranking.js";

export type ArenaMetrics = Readonly<Record<string, Omit<ArenaCandidateSummary, "modelId">>>;

export type ArenaReport = Readonly<{
  task: string;
  champion: string;
  judges: readonly string[];
  comparisons: number;
  positionBiasRate: number | null;
  /** Overall winner ranking per judge kind ("human", "vlm") plus "all". */
  overall: Readonly<Record<string, readonly RankedCandidate[]>>;
  /** Ranking per criterion (`caseId#criterion` judgments), all judges pooled. */
  criteria: Readonly<Record<string, readonly RankedCandidate[]>>;
  pareto: Readonly<{ frontier: readonly string[]; incomplete: readonly string[] }>;
  proposals: readonly PromotionProposal[];
}>;

const judgeKind = (judge: string) => (judge === "human" ? "human" : "vlm");

/**
 * Promotion decides on human head-to-head when there are enough human labels, else on the pooled
 * judges; the proposal notes which one, since VLM-only rankings are advisory.
 */
export const buildArenaReport = (
  input: Readonly<{
    task: string;
    champion: string;
    candidates: readonly string[];
    judgments: readonly PairwiseJudgment[];
    metrics: ArenaMetrics;
  }>,
): ArenaReport => {
  const outcomes = reconcileJudgments(input.judgments);
  const overallOutcomes = outcomes.filter((o) => !o.caseId.includes("#"));
  const byKind = (kind: string) => overallOutcomes.filter((o) => judgeKind(o.judge) === kind);
  const criteria = new Map<string, PairwiseOutcome[]>();
  for (const o of outcomes) {
    const criterion = o.caseId.split("#")[1];
    if (criterion) criteria.set(criterion, [...(criteria.get(criterion) ?? []), o]);
  }
  const overall = bradleyTerry(overallOutcomes);
  const human = byKind("human");
  const pareto = paretoFrontier(
    input.candidates.map((id) => {
      const m = input.metrics[id];
      const score = overall.find((r) => r.id === id)?.score;
      return {
        id,
        metrics: {
          ...(score === undefined ? {} : { quality: score }),
          ...(m?.latencyP95Ms == null ? {} : { latency: m.latencyP95Ms }),
          ...(m ? { failureRate: m.failureRate } : {}),
          ...(m?.peakVramMb == null ? {} : { vram: m.peakVramMb }),
        },
      };
    }),
    [
      { key: "quality", goal: "max" },
      { key: "latency", goal: "min" },
      { key: "failureRate", goal: "min" },
      { key: "vram", goal: "min" },
    ],
  );
  const championMetrics = input.metrics[input.champion];
  const proposals = championMetrics
    ? input.candidates
        .filter((id) => id !== input.champion && input.metrics[id])
        .map((id) => {
          const humanH2H = headToHead(human, id, input.champion);
          const useHuman = humanH2H.comparisons >= 6;
          const proposal = proposePromotion({
            task: input.task,
            champion: { modelId: input.champion, ...championMetrics },
            challenger: { modelId: id, ...(input.metrics[id] as ArenaMetrics[string]) },
            headToHead: useHuman ? humanH2H : headToHead(overallOutcomes, id, input.champion),
          });
          return {
            ...proposal,
            notes: [...proposal.notes, useHuman ? "decided_on_human_labels" : "vlm_only_advisory"],
          };
        })
    : [];
  return {
    task: input.task,
    champion: input.champion,
    judges: [...new Set(input.judgments.map((j) => j.judge))].sort(),
    comparisons: overallOutcomes.length,
    positionBiasRate: outcomes.length
      ? Math.round((outcomes.filter((o) => o.positionBias).length / outcomes.length) * 1000) / 1000
      : null,
    overall: { all: overall, human: bradleyTerry(human), vlm: bradleyTerry(byKind("vlm")) },
    criteria: Object.fromEntries([...criteria].map(([k, v]) => [k, bradleyTerry(v)])),
    pareto,
    proposals,
  };
};

const table = (rows: readonly RankedCandidate[]) =>
  [
    "| Candidate | Score | W | L | T | Rejected |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.id} | ${r.score} | ${r.wins} | ${r.losses} | ${r.ties} | ${r.rejected} |`,
    ),
  ].join("\n");

export const renderArenaMarkdown = (report: ArenaReport): string =>
  [
    `# Arena report: ${report.task}`,
    "",
    `Champion: \`${report.champion}\`. Judges: ${report.judges.join(", ") || "none"}. Overall comparisons: ${report.comparisons}. Position-bias rate: ${report.positionBiasRate ?? "n/a"}.`,
    "",
    "## Overall (all judges)",
    "",
    table(report.overall.all ?? []),
    "",
    "## Overall (human only)",
    "",
    table(report.overall.human ?? []),
    "",
    ...Object.entries(report.criteria).flatMap(([criterion, rows]) => [
      `## ${criterion}`,
      "",
      table(rows),
      "",
    ]),
    "## Pareto frontier (quality, latency, failure rate, VRAM)",
    "",
    `Frontier: ${report.pareto.frontier.join(", ") || "none"}. Not comparable (missing metrics): ${report.pareto.incomplete.join(", ") || "none"}.`,
    "",
    "## Promotion proposals (advice only; policy changes by commit)",
    "",
    ...report.proposals.map(
      (p) =>
        `- \`${p.challenger}\` vs \`${p.champion}\`: **${p.recommendation}**; win rate ${p.winRate ?? "n/a"} over ${p.comparisons}; latency x${p.latencyRatio ?? "n/a"}; failure delta ${p.failureRateDelta}; reasons: ${p.reasons.join(", ") || "none"}; notes: ${p.notes.join(", ") || "none"}.`,
    ),
    "",
  ].join("\n");
