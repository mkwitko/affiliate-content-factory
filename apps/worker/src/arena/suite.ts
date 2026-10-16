import type { ArenaCandidate, ArenaTask } from "@money-maker/core/arena/catalog";
import type { CandidateResult, CaseResult } from "@money-maker/core/arena/leaderboard";
import type { ArenaStage } from "@money-maker/core/arena/promotion";
import type { ArenaEnv } from "./runtime.js";

/**
 * One arena task. `run` measures one candidate (its runtime is already downloaded); `judge`
 * runs after every candidate, with a fixed judge model (ASR, VLM) that fills quality metrics.
 * Output files go to `<outDir>/<dir>/`, where `dir` is a neutral folder name (c01, c02...) so a
 * human page built from the folders stays blind.
 */
export type SuiteContext = Readonly<{
  env: ArenaEnv;
  stage: ArenaStage;
  outDir: string;
  dir: string;
  candidate: ArenaCandidate;
}>;

export type Suite = Readonly<{
  task: ArenaTask;
  /** "image" or "audio" files named <caseId>.<ext> in each candidate folder feed the human page. */
  media: Readonly<{ kind: "image" | "audio" | "video" | "text"; ext: string }>;
  run(context: SuiteContext): Promise<CandidateResult>;
  judge?(
    results: readonly CandidateResult[],
    context: Readonly<{
      env: ArenaEnv;
      stage: ArenaStage;
      outDir: string;
      dirs: ReadonlyMap<string, string>;
    }>,
  ): Promise<readonly CandidateResult[]>;
  /** Brief shown above each case on the human page. */
  brief?(caseId: string): string;
}>;

export const percentile = (values: readonly number[], p: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? null
    : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);
};

export const mean = (values: readonly (number | null | undefined)[]): number | null => {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return present.length ? present.reduce((s, v) => s + v, 0) / present.length : null;
};

/** Mean of every case metric, plus failureRate (cases with `failed` = 1). */
export const aggregateCases = (cases: readonly CaseResult[]): Record<string, number | null> => {
  const keys = [...new Set(cases.flatMap((c) => Object.keys(c.metrics)))];
  return Object.fromEntries(keys.map((key) => [key, mean(cases.map((c) => c.metrics[key]))]));
};

export const okResult = (
  context: Pick<SuiteContext, "candidate" | "stage">,
  cases: readonly CaseResult[],
  extra: Readonly<{
    aggregate?: Readonly<Record<string, number | null>>;
    latenciesMs: readonly number[];
    peakRamMb?: number | null;
    /** Distinct per-case error messages, kept for the report when cases fail. */
    caseErrors?: readonly string[];
  }>,
): CandidateResult => {
  const failed = cases.filter((c) => c.metrics.failed === 1).length;
  return {
    id: context.candidate.id,
    status: "ok",
    stage: context.stage,
    cases,
    aggregate: {
      ...aggregateCases(cases),
      failureRate: cases.length ? failed / cases.length : 1,
      p50LatencyMs: percentile(extra.latenciesMs, 0.5),
      peakRamMb: extra.peakRamMb ?? null,
      ...extra.aggregate,
    },
    latencyP95Ms: percentile(extra.latenciesMs, 0.95),
    failureRate: cases.length ? failed / cases.length : 1,
    peakVramMb: null,
    ...(extra.caseErrors?.length ? { caseErrors: extra.caseErrors.slice(0, 5) } : {}),
  };
};

/** Case count per stage for a corpus of `total` cases (smoke 6, qualification 18, full all). */
export const casesForStage = <T>(
  items: readonly T[],
  stage: ArenaStage,
  sizes = { smoke: 6, qualification: 18 },
) => (stage === "full" ? items : items.slice(0, sizes[stage]));
