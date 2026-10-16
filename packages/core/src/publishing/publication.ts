import type { WorkspaceId } from "@money-maker/contracts";
import type { ProviderConnection } from "../providers/provider-connection.js";

export type PublicationStatus =
  | "queued"
  | "publishing"
  | "published"
  | "retryable_failure"
  | "permanent_failure"
  | "unknown_outcome"
  | "cancelled";

export type CreatePublicationAttemptInput = Readonly<{
  attemptId: string;
  workspaceId: WorkspaceId;
  contentVariantId: string;
  channelId: string;
  connectionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  correlationId: string;
  /** When the post goes out; absent means as soon as the worker runs. */
  scheduledAt?: Date;
}>;

export type PublicationAttempt = Readonly<
  CreatePublicationAttemptInput & {
    status: PublicationStatus;
    externalId?: string;
    attemptCount: number;
    terminalReason?: string;
    createdAt: Date;
    updatedAt: Date;
  }
>;

export type CreateOrFindPublicationAttemptResult = Readonly<{
  created: boolean;
  attempt: PublicationAttempt;
}>;

/** A publication recorded directly as published, with no provider call (a Stories post made by hand). */
export type CreateManualPublicationInput = Readonly<{
  attemptId: string;
  workspaceId: WorkspaceId;
  contentVariantId: string;
  channelId: string;
  connectionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  correlationId: string;
  publishedAt: Date;
}>;

export interface PublicationAttemptRepository {
  createOrFindByIdempotency(
    input: CreatePublicationAttemptInput,
  ): Promise<CreateOrFindPublicationAttemptResult>;
  /** Idempotent per input.idempotencyKey: a repeat with the same key returns the first attempt. */
  createOrFindManualPublication(
    input: CreateManualPublicationInput,
  ): Promise<CreateOrFindPublicationAttemptResult>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
  }): Promise<PublicationAttempt | null>;
  /** Newest attempt per variant id; variants without attempts are absent from the map. */
  listLatestForVariants(input: {
    workspaceId: WorkspaceId;
    variantIds: readonly string[];
  }): Promise<ReadonlyMap<string, PublicationAttempt>>;
  markPublishing(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
  }): Promise<PublicationAttempt | null>;
  recordPublished(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
    externalId: string;
  }): Promise<PublicationAttempt>;
  recordFailure(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
    status: Extract<
      PublicationStatus,
      "retryable_failure" | "permanent_failure" | "unknown_outcome"
    >;
    reason: string;
  }): Promise<PublicationAttempt>;
}

const requireText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} is required`);
  return normalized;
};

export const createQueuedPublicationAttempt = async (input: {
  command: Readonly<{
    attemptId: string;
    workspaceId: WorkspaceId;
    contentVariantId: string;
    channelId: string;
    connection: ProviderConnection;
    approval: "draft" | "approved";
    idempotencyKey: string;
    requestFingerprint: string;
    correlationId: string;
    scheduledAt?: Date;
  }>;
  attempts: PublicationAttemptRepository;
}): Promise<CreateOrFindPublicationAttemptResult> => {
  const { command, attempts } = input;
  if (command.approval !== "approved") throw new Error("content_not_approved");
  if (command.connection.workspaceId !== command.workspaceId) {
    throw new Error("provider_connection_forbidden");
  }
  if (command.connection.status !== "active") {
    throw new Error("provider_connection_unavailable");
  }
  return attempts.createOrFindByIdempotency({
    attemptId: requireText(command.attemptId, "Publication attempt ID"),
    workspaceId: command.workspaceId,
    contentVariantId: requireText(command.contentVariantId, "Content variant ID"),
    channelId: requireText(command.channelId, "Channel ID"),
    connectionId: requireText(command.connection.id, "Provider connection ID"),
    idempotencyKey: requireText(command.idempotencyKey, "Publication idempotency key"),
    requestFingerprint: requireText(command.requestFingerprint, "Publication request fingerprint"),
    correlationId: requireText(command.correlationId, "Publication correlation ID"),
    ...(command.scheduledAt ? { scheduledAt: command.scheduledAt } : {}),
  });
};
