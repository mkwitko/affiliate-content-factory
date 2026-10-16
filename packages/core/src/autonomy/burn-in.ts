import type { WorkspaceId } from "@money-maker/contracts";
import type { VariantState } from "../content/content.js";
import type { JobCount } from "../jobs/job-stats.js";
import { runAutonomyCycle, type AutonomyCounters, type AutonomyCycleDeps } from "./cycle.js";
import { getAutonomyStatus, type AutonomyStatusDeps } from "./status.js";

/** Row counts the burn-in diffs between start and end. Injected so core stays repository-agnostic. */
export type BurnInCounts = Readonly<{
  offers: number;
  contentItems: number;
  publicationAttempts: number;
}>;

export type BurnInDeps = Readonly<{
  cycle: AutonomyCycleDeps;
  status: AutonomyStatusDeps;
  counts: (workspaceId: WorkspaceId) => Promise<BurnInCounts>;
}>;

export type BurnInClock = Readonly<{
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}>;

type Snapshot = Awaited<ReturnType<typeof getAutonomyStatus>>;

export type BurnInResult = {
  startedAt: string;
  endedAt: string | null;
  hours: number;
  intervalMs: number;
  cycles: number;
  stoppedBy: "running" | "elapsed" | "signal";
  workspaceIds: readonly string[];
  /** Per-cycle counters summed over every cycle and workspace. */
  totals: {
    candidatesQualified: number;
    candidatesRejected: number;
    candidatesDiscoveredRuns: number;
    candidatesConsumed: number;
    candidatesExpired: number;
    packageJobsEnqueued: number;
    errors: number;
    errorCodes: Record<string, number>;
  };
  offersCreated: number;
  contentItemsCreated: number;
  /** The invariant: a burn-in never publishes, so this must be 0. */
  publicationAttemptsCreated: number;
  variantsByState: {
    start: Partial<Record<VariantState, number>>;
    end: Partial<Record<VariantState, number>>;
  };
  jobs: readonly { name: string; status: string; start: number; end: number; delta: number }[];
  /** Jobs that newly reached FAILED (permanent) during the window. */
  failedJobs: number;
  queueDepthMax: number;
  /** Largest `awaiting - target` seen for any niche; must stay <= 0. */
  awaitingOverTargetMax: number;
  needsAttentionAtEnd: number;
  /** Candidates marked duplicate by the cycle; enqueue-level idempotent hits are not observable. */
  duplicatePrevention: { candidateDuplicates: number; idempotentEnqueueHits: null };
  /** Not observable through JobStats today; reported as null, never estimated. */
  retries: null;
  stuckJobs: null;
  latencyMs: { p50: null; p95: null };
  violations: readonly string[];
};

const sum = (items: readonly number[]) => items.reduce((a, b) => a + b, 0);
const jobKey = (job: Pick<JobCount, "name" | "status">) => `${job.name}\u0000${job.status}`;

const mergeJobs = (snapshots: readonly Snapshot[]): Map<string, JobCount> => {
  const merged = new Map<string, JobCount>();
  for (const job of snapshots.flatMap((snapshot) => snapshot.jobs)) {
    const key = jobKey(job);
    merged.set(key, { ...job, count: (merged.get(key)?.count ?? 0) + job.count });
  }
  return merged;
};

const mergeVariants = (snapshots: readonly Snapshot[]) => {
  const out: Partial<Record<VariantState, number>> = {};
  for (const snapshot of snapshots)
    for (const [state, count] of Object.entries(snapshot.production.variantsByState))
      out[state as VariantState] = (out[state as VariantState] ?? 0) + count;
  return out;
};

/**
 * Runs autonomy cycles every `intervalMs` for `hours` of clock time and reports what happened.
 * It never publishes (the cycle cannot); the injected counts prove it. Unknown metrics stay null.
 * State lives in the database, so a restarted run simply continues.
 */
export const runBurnIn = async (
  deps: BurnInDeps,
  input: Readonly<{
    workspaceIds: readonly WorkspaceId[];
    hours: number;
    intervalMs: number;
    clock: BurnInClock;
    signal?: AbortSignal;
    /** Called after every cycle with a crash-safe partial result. */
    onCycle?: (result: BurnInResult) => void | Promise<void>;
  }>,
): Promise<BurnInResult> => {
  const { workspaceIds, clock, signal } = input;
  const started = clock.now();
  const endAt = started.getTime() + input.hours * 3_600_000;
  const statusOf = (now: Date) =>
    Promise.all(
      workspaceIds.map((workspaceId) => getAutonomyStatus(deps.status, { workspaceId, now })),
    );
  const countsOf = async () => {
    const all = await Promise.all(workspaceIds.map((workspaceId) => deps.counts(workspaceId)));
    return {
      offers: sum(all.map((c) => c.offers)),
      contentItems: sum(all.map((c) => c.contentItems)),
      publicationAttempts: sum(all.map((c) => c.publicationAttempts)),
    };
  };

  const startStatus = await statusOf(started);
  const startCounts = await countsOf();
  const startJobs = mergeJobs(startStatus);
  const startVariants = mergeVariants(startStatus);
  const totals: BurnInResult["totals"] = {
    candidatesQualified: 0,
    candidatesRejected: 0,
    candidatesDiscoveredRuns: 0,
    candidatesConsumed: 0,
    candidatesExpired: 0,
    packageJobsEnqueued: 0,
    errors: 0,
    errorCodes: {},
  };
  let duplicates = 0;
  let cycles = 0;
  let queueDepthMax = Math.max(0, ...startStatus.map((s) => s.localAi.queueDepth));
  let awaitingOverTargetMax = Number.NEGATIVE_INFINITY;
  let endStatus = startStatus;
  let endCounts = startCounts;
  let stoppedBy: BurnInResult["stoppedBy"] = "running";
  let endedAt: string | null = null;

  const record = (error: string) => {
    totals.errors += 1;
    totals.errorCodes[error] = (totals.errorCodes[error] ?? 0) + 1;
  };
  const result = (): BurnInResult => {
    const endJobs = mergeJobs(endStatus);
    const keys = new Set([...startJobs.keys(), ...endJobs.keys()]);
    const jobs = [...keys].sort().map((key) => {
      const row = endJobs.get(key) ?? startJobs.get(key);
      const start = startJobs.get(key)?.count ?? 0;
      const end = endJobs.get(key)?.count ?? 0;
      return { name: row?.name ?? "", status: row?.status ?? "", start, end, delta: end - start };
    });
    const publicationAttemptsCreated =
      endCounts.publicationAttempts - startCounts.publicationAttempts;
    return {
      startedAt: started.toISOString(),
      endedAt,
      hours: input.hours,
      intervalMs: input.intervalMs,
      cycles,
      stoppedBy,
      workspaceIds,
      totals,
      offersCreated: endCounts.offers - startCounts.offers,
      contentItemsCreated: endCounts.contentItems - startCounts.contentItems,
      publicationAttemptsCreated,
      variantsByState: { start: startVariants, end: mergeVariants(endStatus) },
      jobs,
      failedJobs: sum(jobs.filter((job) => job.status === "FAILED").map((job) => job.delta)),
      queueDepthMax,
      awaitingOverTargetMax: Number.isFinite(awaitingOverTargetMax) ? awaitingOverTargetMax : 0,
      needsAttentionAtEnd: sum(endStatus.map((s) => s.needsAttention.length)),
      duplicatePrevention: { candidateDuplicates: duplicates, idempotentEnqueueHits: null },
      retries: null,
      stuckJobs: null,
      latencyMs: { p50: null, p95: null },
      violations: [
        ...(publicationAttemptsCreated !== 0 ? ["publication_attempts_created"] : []),
        ...(awaitingOverTargetMax > 0 ? ["awaiting_over_target"] : []),
      ],
    };
  };

  while (clock.now().getTime() < endAt && !signal?.aborted) {
    const now = clock.now();
    for (const workspaceId of workspaceIds) {
      let counters: AutonomyCounters | null = null;
      try {
        counters = await runAutonomyCycle(deps.cycle, { workspaceId, now });
      } catch {
        record("cycle:THREW");
      }
      if (!counters) continue;
      totals.candidatesQualified += counters.qualified;
      totals.candidatesRejected += counters.rejected;
      totals.candidatesDiscoveredRuns += counters.discoveredRuns;
      totals.candidatesConsumed += counters.consumed;
      totals.candidatesExpired += counters.expired;
      totals.packageJobsEnqueued += counters.packageJobsEnqueued;
      duplicates += counters.duplicates;
      counters.errors.forEach(record);
    }
    cycles += 1;
    try {
      endStatus = await statusOf(now);
      endCounts = await countsOf();
      queueDepthMax = Math.max(queueDepthMax, ...endStatus.map((s) => s.localAi.queueDepth));
      for (const status of endStatus)
        for (const niche of status.affiliate)
          awaitingOverTargetMax = Math.max(awaitingOverTargetMax, niche.awaiting - niche.target);
    } catch {
      record("snapshot:THREW");
    }
    await input.onCycle?.(result());
    if (clock.now().getTime() + input.intervalMs >= endAt) break;
    await clock.sleep(input.intervalMs);
  }

  stoppedBy = signal?.aborted ? "signal" : "elapsed";
  endedAt = clock.now().toISOString();
  const final = result();
  await input.onCycle?.(final);
  return final;
};
