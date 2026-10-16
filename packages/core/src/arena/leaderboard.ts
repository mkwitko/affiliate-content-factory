import type { ArenaTask } from "./catalog.js";
import {
  type ArenaStage,
  type PromotionProposal,
  paretoFrontier,
  proposePromotion,
  type StageStatus,
} from "./promotion.js";

/**
 * Quantitative leaderboard for one arena task: every candidate's aggregate metrics, hard gates,
 * a per-case head-to-head against the champion on the task's primary metric, the Pareto set and a
 * promotion proposal. Pure: the runner measures, this only compares.
 */
export type CandidateStatus =
  | "ok"
  | "NOT_TESTED"
  | "OOM"
  | "RUNTIME_BLOCKED"
  | "LICENSE_BLOCKED"
  | "FAILED";

export type CaseResult = Readonly<{
  caseId: string;
  metrics: Readonly<Record<string, number | null>>;
}>;

export type CandidateResult = Readonly<{
  id: string;
  status: CandidateStatus;
  error?: string;
  stage: ArenaStage;
  cases: readonly CaseResult[];
  /** Task metrics over all cases, e.g. { cer: 0.03, rtf: 0.9 }. */
  aggregate: Readonly<Record<string, number | null>>;
  latencyP95Ms: number | null;
  failureRate: number;
  peakVramMb: number | null;
  /** Distinct per-case error messages (first five), for the report. */
  caseErrors?: readonly string[];
}>;

export type MetricGoal = "max" | "min";
export type TaskSpec = Readonly<{
  /** Aggregate and per-case metric that decides the ranking. */
  primary: Readonly<{ key: string; goal: MetricGoal; label: string }>;
  /** Hard gates on aggregates; a failed gate keeps a challenger out of promotion. */
  gates: readonly Readonly<{ key: string; op: "<=" | ">="; value: number; label: string }>[];
  /** Extra aggregate columns shown in the report. */
  columns: readonly string[];
  /** Per-case difference below this counts as a tie (metric noise). */
  tieEpsilon: number;
}>;

export const TASK_SPECS: Readonly<Record<ArenaTask, TaskSpec>> = {
  "llm.offer_copy": {
    primary: { key: "passRate", goal: "max", label: "copy passes every gate" },
    gates: [{ key: "runtimeErrorRate", op: "<=", value: 0, label: "no runtime errors" }],
    columns: ["passRate", "worstCasePassRate", "validHookShare", "p50LatencyMs"],
    tieEpsilon: 0,
  },
  "vision.product_verification": {
    primary: { key: "accuracy", goal: "max", label: "right verdict on right/swapped product" },
    gates: [
      { key: "falseAcceptRate", op: "<=", value: 0, label: "never accepts a swapped product" },
      { key: "parseFailureRate", op: "<=", value: 0.05, label: "answers in the schema" },
    ],
    columns: ["accuracy", "falseAcceptRate", "falseRejectRate", "parseFailureRate"],
    tieEpsilon: 0,
  },
  "image.character_product": {
    primary: { key: "productFidelity", goal: "max", label: "VLM confirms the real product" },
    gates: [{ key: "validRate", op: ">=", value: 1, label: "every image decodes at size" }],
    columns: ["productFidelity", "validRate", "pairwiseWinRate", "p50LatencyMs"],
    tieEpsilon: 0,
  },
  "image.scene_plate": {
    primary: { key: "cleanPlate", goal: "max", label: "VLM sees no text, people or product" },
    gates: [{ key: "validRate", op: ">=", value: 1, label: "every image decodes at size" }],
    columns: ["cleanPlate", "validRate", "lumaStdev", "p50LatencyMs"],
    tieEpsilon: 0,
  },
  "tts.ptbr": {
    primary: { key: "cer", goal: "min", label: "character error rate of an ASR round trip" },
    gates: [
      { key: "failureRate", op: "<=", value: 0, label: "every line synthesized" },
      { key: "clippingRatio", op: "<=", value: 0.001, label: "no clipping" },
      { key: "cer", op: "<=", value: 0.08, label: "intelligible (CER <= 8 %)" },
    ],
    columns: ["cer", "wer", "rtf", "charsPerSecond", "rmsDbfs", "edgeSilenceMs"],
    tieEpsilon: 0.005,
  },
  "asr.ptbr": {
    primary: { key: "wer", goal: "min", label: "word error rate on known pt-BR speech" },
    gates: [{ key: "failureRate", op: "<=", value: 0, label: "every clip transcribed" }],
    columns: ["wer", "cer", "rtf"],
    tieEpsilon: 0.005,
  },
  "upscale.illustration": {
    primary: { key: "ssim", goal: "max", label: "SSIM of a 2x round trip vs the original" },
    gates: [{ key: "validRate", op: ">=", value: 1, label: "every image upscaled" }],
    columns: ["ssim", "psnr", "p50LatencyMs"],
    tieEpsilon: 0.002,
  },
  "video.i2v": {
    primary: {
      key: "productFidelity",
      goal: "max",
      label: "VLM finds the product in the last frame",
    },
    gates: [{ key: "validRate", op: ">=", value: 1, label: "every clip decodes" }],
    columns: ["productFidelity", "validRate", "meanFrameDiff", "p50LatencyMs"],
    tieEpsilon: 0,
  },
};

const better = (goal: MetricGoal, a: number, b: number, epsilon: number) =>
  Math.abs(a - b) <= epsilon ? 0 : (goal === "max" ? a > b : a < b) ? 1 : -1;

/** Challenger's per-case win rate against the champion on the primary metric; ties count half. */
export const caseHeadToHead = (
  spec: TaskSpec,
  challenger: CandidateResult,
  champion: CandidateResult,
): Readonly<{ comparisons: number; winRate: number | null }> => {
  const theirs = new Map(champion.cases.map((c) => [c.caseId, c.metrics[spec.primary.key]]));
  let points = 0;
  let comparisons = 0;
  for (const c of challenger.cases) {
    const mine = c.metrics[spec.primary.key];
    const other = theirs.get(c.caseId);
    if (mine == null || other == null) continue;
    comparisons += 1;
    const verdict = better(spec.primary.goal, mine, other, spec.tieEpsilon);
    points += verdict === 0 ? 0.5 : verdict > 0 ? 1 : 0;
  }
  return { comparisons, winRate: comparisons ? points / comparisons : null };
};

export const failedGates = (spec: TaskSpec, result: CandidateResult): readonly string[] =>
  result.status !== "ok"
    ? [result.status]
    : spec.gates
        .filter((gate) => {
          const value = result.aggregate[gate.key];
          if (value == null) return true;
          return gate.op === "<=" ? value > gate.value : value < gate.value;
        })
        .map((gate) => gate.label);

export type LeaderboardRow = Readonly<{
  rank: number | null;
  id: string;
  status: CandidateStatus;
  champion: boolean;
  primary: number | null;
  gatesFailed: readonly string[];
  headToHead: Readonly<{ comparisons: number; winRate: number | null }> | null;
  result: CandidateResult;
}>;

export type Leaderboard = Readonly<{
  task: ArenaTask;
  spec: TaskSpec;
  champion: string | null;
  rows: readonly LeaderboardRow[];
  pareto: Readonly<{ frontier: readonly string[]; incomplete: readonly string[] }>;
  proposals: readonly PromotionProposal[];
}>;

const STAGE_ORDER: readonly ArenaStage[] = ["smoke", "qualification", "full"];

export const buildLeaderboard = (
  task: ArenaTask,
  results: readonly CandidateResult[],
  championId: string | null,
): Leaderboard => {
  const spec = TASK_SPECS[task];
  const champion = results.find((r) => r.id === championId && r.status === "ok") ?? null;
  const key = spec.primary.key;
  const sorted = [...results].sort((a, b) => {
    const va = a.status === "ok" ? a.aggregate[key] : null;
    const vb = b.status === "ok" ? b.aggregate[key] : null;
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return spec.primary.goal === "max" ? vb - va : va - vb;
  });
  let rank = 0;
  const rows = sorted.map((result): LeaderboardRow => {
    const primary = result.status === "ok" ? (result.aggregate[key] ?? null) : null;
    if (primary != null) rank += 1;
    return {
      rank: primary == null ? null : rank,
      id: result.id,
      status: result.status,
      champion: result.id === championId,
      primary,
      gatesFailed: failedGates(spec, result),
      headToHead:
        champion && result.id !== champion.id && result.status === "ok"
          ? caseHeadToHead(spec, result, champion)
          : null,
      result,
    };
  });
  const pareto = paretoFrontier(
    results
      .filter((r) => r.status === "ok")
      .map((r) => ({
        id: r.id,
        metrics: Object.fromEntries(
          [
            ["primary", r.aggregate[key]],
            ["latency", r.latencyP95Ms],
            ["failureRate", r.failureRate],
          ].filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        ),
      })),
    [
      { key: "primary", goal: spec.primary.goal },
      { key: "latency", goal: "min" },
      { key: "failureRate", goal: "min" },
    ],
  );
  const stagesOf = (row: LeaderboardRow): Readonly<Record<ArenaStage, StageStatus>> => {
    const reached = STAGE_ORDER.indexOf(row.result.stage);
    const passed = row.gatesFailed.length === 0;
    return Object.fromEntries(
      STAGE_ORDER.map((stage, i) => [stage, i > reached ? "not_run" : passed ? "pass" : "fail"]),
    ) as Record<ArenaStage, StageStatus>;
  };
  const championRow = rows.find((row) => row.id === champion?.id);
  const summary = (row: LeaderboardRow) => ({
    modelId: row.id.split("#")[0] as string,
    stages: stagesOf(row),
    latencyP95Ms: row.result.latencyP95Ms,
    failureRate: row.result.failureRate,
    peakVramMb: row.result.peakVramMb,
    criticalRegressions: row.gatesFailed,
  });
  const proposals = championRow
    ? rows
        .filter((row) => row.headToHead && row.status === "ok")
        .map((row) => ({
          ...proposePromotion({
            task,
            champion: summary(championRow),
            challenger: summary(row),
            headToHead: row.headToHead as NonNullable<LeaderboardRow["headToHead"]>,
          }),
          challenger: row.id,
          champion: championRow.id,
        }))
    : [];
  return { task, spec, champion: champion?.id ?? null, rows, pareto, proposals };
};

const fmt = (value: number | null | undefined) =>
  value == null
    ? "n/a"
    : Math.abs(value) >= 100
      ? String(Math.round(value))
      : String(Math.round(value * 1000) / 1000);

export const renderLeaderboardMarkdown = (board: Leaderboard): string => {
  const { spec } = board;
  const header = [
    "#",
    "Candidate",
    "Status",
    ...spec.columns,
    "p95 ms",
    "fail",
    "vs champion",
    "Gates",
  ];
  return [
    `# Arena leaderboard: ${board.task}`,
    "",
    `Ranked by **${spec.primary.key}** (${spec.primary.goal}): ${spec.primary.label}. Champion: \`${board.champion ?? "none"}\`.`,
    `Gates: ${spec.gates.map((g) => `${g.label} (${g.key} ${g.op} ${g.value})`).join("; ")}.`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...board.rows.map(
      (row) =>
        `| ${row.rank ?? "-"} | ${row.champion ? `**${row.id}**` : row.id} | ${row.status}${row.result.error ? ` (${row.result.error})` : ""} | ${spec.columns
          .map((c) => fmt(row.result.aggregate[c]))
          .join(" | ")} | ${fmt(row.result.latencyP95Ms)} | ${fmt(row.result.failureRate)} | ${
          row.headToHead ? `${fmt(row.headToHead.winRate)} (${row.headToHead.comparisons})` : "-"
        } | ${row.gatesFailed.length ? row.gatesFailed.join("; ") : "pass"} |`,
    ),
    "",
    `Pareto (primary, latency, failure rate): ${board.pareto.frontier.join(", ") || "none"}.`,
    "",
    "## Promotion proposals (advice; model policy changes only by commit)",
    "",
    ...(board.proposals.length
      ? board.proposals.map(
          (p) =>
            `- \`${p.challenger}\`: **${p.recommendation}**; case win rate ${fmt(p.winRate)} over ${p.comparisons}; latency x${fmt(p.latencyRatio)}; reasons: ${p.reasons.join(", ") || "none"}; notes: ${p.notes.join(", ") || "none"}.`,
        )
      : ["- none (no champion result to compare against)"]),
    "",
  ].join("\n");
};
