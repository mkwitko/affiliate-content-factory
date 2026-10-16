/**
 * Local vs cloud comparison of finished five-second clips (cloud GPU pilot, runbook
 * MODEL-BENCHMARK-RUNBOOK.md). Deterministic: same rows, same report. A clip counts as accepted
 * only with a human verdict; the VLM verdict is advisory (it passed a ghosted Wan face on
 * 2026-10-08). Missing evidence prints NOT RUN, never an estimate.
 */
export const BENCHMARK_CASES = [
  { id: "A", subject: "transparent makeup organizer", critical: "opacity/edges changed" },
  {
    id: "B",
    subject: "three-shelf rack beside laundry",
    critical: "extra shelf or duplicate Carla",
  },
  { id: "C", subject: "power bank / port", critical: "changed connectors/logo/cable" },
  { id: "D", subject: "earbuds held in hand", critical: "ghost fingers or wrong product" },
  {
    id: "E",
    subject: "Sam explaining a price in a supermarket",
    critical: "identity drift, unreadable text",
  },
  {
    id: "F",
    subject: "repeating Sam scene with camera movement",
    critical: "face or costume changes",
  },
] as const;
export type BenchmarkCaseId = (typeof BENCHMARK_CASES)[number]["id"];

export type ClipRun = Readonly<{
  caseId: BenchmarkCaseId;
  candidate: string;
  /** From the server's own probe of the stored file, not the provider's claim. */
  probe: Readonly<{ durationMs: number; width: number; height: number; fps: number }> | null;
  vlmPass: boolean | null;
  humanVerdict: "accept" | "reject" | null;
  rejectReason?: string;
  /** Settled BRL centavos; 0 for local runs, null while unknown. */
  costMinor: number | null;
}>;

const technicalOk = (run: ClipRun) =>
  run.probe !== null && Math.abs(run.probe.durationMs - 5_000) <= 250;

export const summarizeClipRuns = (runs: readonly ClipRun[]) => {
  const candidates = [...new Set(runs.map((run) => run.candidate))].sort();
  return candidates.map((candidate) => {
    const own = runs.filter((run) => run.candidate === candidate);
    const judged = own.filter((run) => run.humanVerdict !== null);
    const accepted = own.filter((run) => run.humanVerdict === "accept" && technicalOk(run));
    const costs = own.map((run) => run.costMinor);
    const costKnown = costs.every((cost) => cost !== null);
    const totalMinor = costKnown ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null;
    return {
      candidate,
      attempted: own.length,
      judged: judged.length,
      accepted: accepted.length,
      technicalFailures: own.filter((run) => !technicalOk(run)).length,
      vlmPassedHumanRejected: own.filter(
        (run) => run.vlmPass === true && run.humanVerdict === "reject",
      ).length,
      totalMinor,
      minorPerAccepted:
        totalMinor === null || accepted.length === 0
          ? null
          : Math.ceil(totalMinor / accepted.length),
      missingCases: BENCHMARK_CASES.filter(
        (item) => !own.some((run) => run.caseId === item.id),
      ).map((item) => item.id),
    };
  });
};

const brl = (minor: number | null) =>
  minor === null ? "NOT RUN" : `R$ ${(minor / 100).toFixed(2).replace(".", ",")}`;

export const renderClipComparison = (runs: readonly ClipRun[]): string =>
  [
    "| Candidate | Accepted / attempted | Human-judged | Technical failures | VLM pass, human reject | Total cost | Cost per accepted 5 s | Missing cases |",
    "|---|---|---|---|---|---|---|---|",
    ...summarizeClipRuns(runs)
      .map((row) =>
        [
          row.candidate,
          row.judged === 0 ? "NOT RUN" : `${row.accepted} / ${row.attempted}`,
          `${row.judged} / ${row.attempted}`,
          String(row.technicalFailures),
          String(row.vlmPassedHumanRejected),
          brl(row.totalMinor),
          brl(row.minorPerAccepted),
          row.missingCases.join(", ") || "none",
        ].join(" | "),
      )
      .map((line) => `| ${line} |`),
  ].join("\n");
