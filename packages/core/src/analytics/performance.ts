import type { WorkspaceId } from "@money-maker/contracts";
import type { ProviderConnectionRepository } from "../providers/provider-connection-repository.js";
import type { CheckpointDays, CheckpointObservation } from "./learnings.js";
import type { SocialPublisher } from "../publishing/social-publisher.js";

/** Lifetime counts the platform reports for one post; a platform may omit any of them. */
export type PostMetrics = Readonly<{
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  profileVisits?: number;
  estimatedMinutesWatched?: number;
  averageViewDurationSeconds?: number;
  averageViewPercentage?: number;
  subscribersGained?: number;
  subscribersLost?: number;
  engagedViews?: number;
}>;
export type PerformanceObservation = Readonly<{
  workspaceId: WorkspaceId;
  contentVariantId: string;
  publicationAttemptId: string;
  observedAt: Date;
  metrics: PostMetrics;
  platformUrl?: string;
}>;
export type VariantPerformance = PerformanceObservation &
  Readonly<{
    channelId: string;
    publishedAt: Date | null;
    /** The variant's recorded creative choices, when it has them. */
    creativeFeatures: unknown;
  }>;
/** A published post and how many times its metrics were already read. */
export type MetricSyncCandidate = Readonly<{
  workspaceId: WorkspaceId;
  publicationAttemptId: string;
  contentVariantId: string;
  connectionId: string;
  externalId: string;
  publishedAt: Date;
  observationCount: number;
}>;
export interface PerformanceRepository {
  /** Published attempts with an external id, published at or after `since`. */
  listSyncCandidates(since: Date): Promise<readonly MetricSyncCandidate[]>;
  record(observation: PerformanceObservation): Promise<void>;
  /**
   * The newest non-empty observation of each variant (an empty one only when it has no other),
   * newest posts first, at most `limit` posts.
   */
  latestByVariant(
    workspaceId: WorkspaceId,
    options?: Readonly<{ since?: Date; limit?: number }>,
  ): Promise<readonly VariantPerformance[]>;
  /**
   * Per published post, the non-empty observation closest to and not before
   * `publishedAt + checkpointDays`, with the post's creative choices and unique clicks.
   */
  observationsAtCheckpoint(
    workspaceId: WorkspaceId,
    options: Readonly<{ checkpointDays: CheckpointDays; since?: Date }>,
  ): Promise<readonly CheckpointObservation[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Metrics are read once 1, 3, 7, and 30 days after publication, then never again. */
export const METRIC_CHECKPOINTS_MS: readonly number[] = [1, 3, 7, 30].map((days) => days * DAY_MS);
export const isMetricSyncDue = (publishedAt: Date, observationCount: number, now: Date): boolean =>
  METRIC_CHECKPOINTS_MS.filter((checkpoint) => now.getTime() - publishedAt.getTime() >= checkpoint)
    .length > observationCount;

// ponytail: no unique (attempt, checkpoint) constraint; safe because the worker runs as a single
// replica. Add a checkpoint column with a unique index before running more than one worker.
/**
 * Reads metrics for every published post whose next checkpoint has passed. A provider that
 * returns nothing (no analytics permission, post not found) still produces an empty
 * observation, so the post is not retried every sweep. One failure never stops the sweep.
 */
export const runDueMetricSyncs = async (deps: {
  performance: PerformanceRepository;
  connections: Pick<ProviderConnectionRepository, "findForWorkspace">;
  publisherForWorkspace: (workspaceId: WorkspaceId) => SocialPublisher;
  now?: () => Date;
  onError?: (error: unknown) => void;
}): Promise<void> => {
  const now = (deps.now ?? (() => new Date()))();
  const lastCheckpoint = METRIC_CHECKPOINTS_MS.at(-1) ?? 0;
  const candidates = await deps.performance.listSyncCandidates(
    new Date(now.getTime() - lastCheckpoint - DAY_MS),
  );
  for (const candidate of candidates) {
    if (!isMetricSyncDue(candidate.publishedAt, candidate.observationCount, now)) continue;
    const record = (read: { metrics: PostMetrics; platformUrl?: string } | null) =>
      deps.performance.record({
        workspaceId: candidate.workspaceId,
        contentVariantId: candidate.contentVariantId,
        publicationAttemptId: candidate.publicationAttemptId,
        observedAt: now,
        metrics: read?.metrics ?? {},
        ...(read?.platformUrl ? { platformUrl: read.platformUrl } : {}),
      });
    try {
      const connection = await deps.connections.findForWorkspace({
        workspaceId: candidate.workspaceId,
        connectionId: candidate.connectionId,
      });
      const reader = deps.publisherForWorkspace(candidate.workspaceId).readMetrics;
      if (!connection || !reader) continue;
      const read = await reader({
        secretReference: connection.secretReference,
        accountId: connection.accountId,
        externalId: candidate.externalId,
      });
      await record(read);
    } catch (error) {
      // A refused key (no analytics permission, revoked key) will not fix itself within the
      // hour: record the checkpoint as empty instead of retrying every sweep for 30 days.
      if (error instanceof Error && error.message === "provider_credential_expired") {
        await record(null).catch(deps.onError);
      }
      deps.onError?.(error);
    }
  }
};
