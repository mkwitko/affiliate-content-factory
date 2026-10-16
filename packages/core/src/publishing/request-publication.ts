import type { WorkspaceId } from "@money-maker/contracts";
import type { Channel } from "../channels/channel.js";
import type { ContentVariant } from "../content/content.js";
import { createPublishContentJob, type JobQueue } from "../jobs/job.js";
import type { ProviderConnection } from "../providers/provider-connection.js";
import {
  type CreateOrFindPublicationAttemptResult,
  createQueuedPublicationAttempt,
  type PublicationAttemptRepository,
} from "./publication.js";

export const requestPublication = async (
  input: Readonly<{
    workspaceId: WorkspaceId;
    variant: ContentVariant;
    channel: Channel;
    connection: ProviderConnection;
    attempts: PublicationAttemptRepository;
    queue: Pick<JobQueue, "enqueue">;
    attemptId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    correlationId: string;
    /** Scheduled publication: the job waits in the queue, so media URLs are signed at publish time. */
    publishAt?: Date;
  }>,
): Promise<CreateOrFindPublicationAttemptResult> => {
  if (
    input.variant.workspaceId !== input.workspaceId ||
    input.channel.workspaceId !== input.workspaceId
  ) {
    throw new Error("publication_workspace_mismatch");
  }
  if (input.variant.channelId !== input.channel.id) throw new Error("publication_channel_mismatch");
  if (input.variant.state !== "approved" || !input.variant.approval) {
    throw new Error("content_not_approved");
  }
  const result = await createQueuedPublicationAttempt({
    command: {
      attemptId: input.attemptId,
      workspaceId: input.workspaceId,
      contentVariantId: input.variant.id,
      channelId: input.channel.id,
      connection: input.connection,
      approval: "approved",
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      correlationId: input.correlationId,
      ...(input.publishAt ? { scheduledAt: input.publishAt } : {}),
    },
    attempts: input.attempts,
  });
  await input.queue.enqueue(
    createPublishContentJob({
      workspaceId: input.workspaceId,
      attemptId: result.attempt.attemptId,
      ...(result.attempt.scheduledAt ? { availableAt: result.attempt.scheduledAt } : {}),
    }),
  );
  return result;
};
