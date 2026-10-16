import type { JobIdentifierPayload } from "@money-maker/core/jobs/job";
import {
  PermanentJobError as PermanentJobFailure,
  RetryLaterJobError,
} from "@money-maker/core/jobs/job";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { PublicationAttemptRepository } from "@money-maker/core/publishing/publication";
import type { SocialPublisher } from "@money-maker/core/publishing/social-publisher";

/** attemptCount is the queue's run number for this job, counted from 1 at claim. */
type ReconcileJob = Readonly<{ payload: JobIdentifierPayload; attemptCount?: number }>;

const baseDelayMs = 15_000;
const maxDelayMs = 15 * 60_000;

/** Exponential backoff from the job's attempt count, capped so the total wait across
 *  reconcilePublicationMaxAttempts stays in the hours the provider can take to settle. */
const stillProcessingDelayMs = (attemptCount: number): number =>
  Math.min(baseDelayMs * 2 ** (attemptCount - 1), maxDelayMs);

export const createReconcilePublicationHandler =
  (
    dependencies: Readonly<{
      attempts: PublicationAttemptRepository;
      connections: Pick<ProviderConnectionRepository, "findForWorkspace">;
      publisher:
        | SocialPublisher
        | ((workspaceId: JobIdentifierPayload["workspaceId"]) => SocialPublisher);
    }>,
  ) =>
  async (job: ReconcileJob): Promise<void> => {
    const attemptId = job.payload.identifiers.attemptId;
    if (!attemptId) throw new PermanentJobFailure();
    const workspaceId = job.payload.workspaceId;
    const attempt = await dependencies.attempts.findForWorkspace({ workspaceId, attemptId });
    if (!attempt) throw new PermanentJobFailure();
    if (attempt.status === "published") return;
    if (attempt.status !== "unknown_outcome") throw new PermanentJobFailure();
    const connection = await dependencies.connections.findForWorkspace({
      workspaceId,
      connectionId: attempt.connectionId,
    });
    if (connection?.status !== "active") throw new PermanentJobFailure();
    const publisher =
      typeof dependencies.publisher === "function"
        ? dependencies.publisher(workspaceId)
        : dependencies.publisher;
    const result = await publisher.reconcile({
      secretReference: connection.secretReference,
      accountId: connection.accountId,
      externalId: attempt.attemptId,
    });
    if (result.status === "published") {
      await dependencies.attempts.recordPublished({
        workspaceId,
        attemptId,
        externalId: result.externalId,
      });
      return;
    }
    if (result.status === "failed") {
      await dependencies.attempts.recordFailure({
        workspaceId,
        attemptId,
        status: "permanent_failure",
        reason: `provider_post_failed: ${result.failureReason ?? "provider_post_failed"}`,
      });
      return;
    }
    await dependencies.attempts.recordFailure({
      workspaceId,
      attemptId,
      status: "unknown_outcome",
      reason: "provider_still_processing",
    });
    const delayMs = stillProcessingDelayMs(job.attemptCount ?? 1);
    throw new RetryLaterJobError("provider_still_processing", new Date(Date.now() + delayMs));
  };
