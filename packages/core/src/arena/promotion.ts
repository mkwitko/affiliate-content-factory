import { mayUseModelCommercially } from "../assets/model-policy.js";

/**
 * Arena stage sizes and promotion thresholds (docs/content-generation/model-arena.md). A proposal
 * is advice for the owner: nothing here changes model policy or production routing.
 */
export const ARENA_STAGES = {
  smoke: { cases: 6, seeds: 1 },
  qualification: { cases: 18, seeds: 2 },
  full: { cases: 30, seeds: 3 },
} as const;
export type ArenaStage = keyof typeof ARENA_STAGES;
export type StageStatus = "pass" | "fail" | "not_run";

export const ARENA_PROMOTION = {
  /** Head-to-head win rate (ties half) the challenger needs against the champion. */
  minWinRate: 0.6,
  minComparisons: ARENA_STAGES.qualification.cases,
  /** Above this p95 latency ratio a winner becomes a QUALITY-tier champion, not the default. */
  maxLatencyRatio: 1.5,
  maxFailureRateIncrease: 0,
  /** RX 6650 XT: 8 GB minus headroom for the desktop session. */
  vramBudgetMb: 7_680,
} as const;

export type ArenaCandidateSummary = Readonly<{
  modelId: string;
  stages: Readonly<Record<ArenaStage, StageStatus>>;
  latencyP95Ms: number | null;
  failureRate: number;
  /** null when the runtime could not report it; the proposal says so instead of guessing. */
  peakVramMb: number | null;
  criticalRegressions: readonly string[];
}>;

export type PromotionProposal = Readonly<{
  task: string;
  champion: string;
  challenger: string;
  recommendation: "promote" | "promote_quality_tier" | "keep" | "reject";
  reasons: readonly string[];
  notes: readonly string[];
  winRate: number | null;
  comparisons: number;
  latencyRatio: number | null;
  failureRateDelta: number;
}>;

export const proposePromotion = (
  input: Readonly<{
    task: string;
    champion: ArenaCandidateSummary;
    challenger: ArenaCandidateSummary;
    headToHead: Readonly<{ comparisons: number; winRate: number | null }>;
  }>,
): PromotionProposal => {
  const { champion, challenger, headToHead } = input;
  const latencyRatio =
    champion.latencyP95Ms && challenger.latencyP95Ms !== null
      ? Math.round((challenger.latencyP95Ms / champion.latencyP95Ms) * 100) / 100
      : null;
  const failureRateDelta = challenger.failureRate - champion.failureRate;
  const notes = challenger.peakVramMb === null ? ["vram_not_measured"] : [];
  const base = {
    task: input.task,
    champion: champion.modelId,
    challenger: challenger.modelId,
    notes,
    winRate: headToHead.winRate,
    comparisons: headToHead.comparisons,
    latencyRatio,
    failureRateDelta,
  };

  const hardStops = [
    ...(mayUseModelCommercially(challenger.modelId) ? [] : ["license_blocked"]),
    ...(challenger.peakVramMb !== null && challenger.peakVramMb > ARENA_PROMOTION.vramBudgetMb
      ? ["vram_over_budget"]
      : []),
  ];
  if (hardStops.length) return { ...base, recommendation: "reject", reasons: hardStops };

  const reasons = [
    ...(Object.keys(ARENA_STAGES) as ArenaStage[])
      .filter((stage) => challenger.stages[stage] !== "pass")
      .map((stage) => `stage_${stage}_${challenger.stages[stage]}`),
    ...challenger.criticalRegressions.map((r) => `critical_regression:${r}`),
    ...(headToHead.comparisons < ARENA_PROMOTION.minComparisons
      ? ["insufficient_comparisons"]
      : []),
    ...(headToHead.winRate === null || headToHead.winRate < ARENA_PROMOTION.minWinRate
      ? ["quality_gain_below_threshold"]
      : []),
    ...(failureRateDelta > ARENA_PROMOTION.maxFailureRateIncrease ? ["failure_rate_higher"] : []),
  ];
  if (reasons.length) return { ...base, recommendation: "keep", reasons };
  if (latencyRatio === null || latencyRatio > ARENA_PROMOTION.maxLatencyRatio)
    return {
      ...base,
      recommendation: "promote_quality_tier",
      reasons: [],
      notes: [...notes, latencyRatio === null ? "latency_not_measured" : "keep_champion_as_fast"],
    };
  return { ...base, recommendation: "promote", reasons: [] };
};

export type ParetoObjective = Readonly<{ key: string; goal: "max" | "min" }>;
export type ParetoPoint = Readonly<{ id: string; metrics: Readonly<Record<string, number>> }>;

/** Non-dominated points. A point missing any objective cannot be compared and is listed apart. */
export const paretoFrontier = (
  points: readonly ParetoPoint[],
  objectives: readonly ParetoObjective[],
): Readonly<{ frontier: readonly string[]; incomplete: readonly string[] }> => {
  const complete = points.filter((p) => objectives.every((o) => Number.isFinite(p.metrics[o.key])));
  const better = (x: ParetoPoint, y: ParetoPoint, o: ParetoObjective) => {
    const [vx, vy] = [x.metrics[o.key] as number, y.metrics[o.key] as number];
    return o.goal === "max" ? vx - vy : vy - vx;
  };
  const dominates = (x: ParetoPoint, y: ParetoPoint) =>
    objectives.every((o) => better(x, y, o) >= 0) && objectives.some((o) => better(x, y, o) > 0);
  return {
    frontier: complete.filter((p) => !complete.some((q) => dominates(q, p))).map((p) => p.id),
    incomplete: points.filter((p) => !complete.includes(p)).map((p) => p.id),
  };
};
