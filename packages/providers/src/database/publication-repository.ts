import { Prisma } from "../../generated/prisma/client.js";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import type {
  CreateManualPublicationInput,
  CreateOrFindPublicationAttemptResult,
  CreatePublicationAttemptInput,
  PublicationAttempt,
  PublicationAttemptRepository,
  PublicationStatus,
} from "@money-maker/core/publishing/publication";
import type { DatabaseClient } from "./client.js";

type PublicationRecord = {
  id: string;
  workspaceId: string;
  contentVariantId: string;
  channelId: string;
  connectionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status:
    | "QUEUED"
    | "PUBLISHING"
    | "PUBLISHED"
    | "RETRYABLE_FAILURE"
    | "PERMANENT_FAILURE"
    | "UNKNOWN_OUTCOME"
    | "CANCELLED";
  externalId: string | null;
  attemptCount: number;
  correlationId: string;
  terminalReason: string | null;
  scheduledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const statusToDomain = (status: PublicationRecord["status"]): PublicationStatus =>
  status.toLowerCase() as PublicationStatus;

const toDomain = (record: PublicationRecord): PublicationAttempt => ({
  attemptId: record.id,
  workspaceId: parseWorkspaceId(record.workspaceId),
  contentVariantId: record.contentVariantId,
  channelId: record.channelId,
  connectionId: record.connectionId,
  idempotencyKey: record.idempotencyKey,
  requestFingerprint: record.requestFingerprint,
  correlationId: record.correlationId,
  status: statusToDomain(record.status),
  ...(record.externalId ? { externalId: record.externalId } : {}),
  attemptCount: record.attemptCount,
  ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
  ...(record.scheduledAt ? { scheduledAt: record.scheduledAt } : {}),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export class PrismaPublicationAttemptRepository implements PublicationAttemptRepository {
  public constructor(private readonly client: DatabaseClient) {}

  private async findByIdempotency(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<PublicationAttempt | null> {
    const record = await this.client.publicationAttempt.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    });
    return record ? toDomain(record as PublicationRecord) : null;
  }

  public async createOrFindByIdempotency(
    input: CreatePublicationAttemptInput,
  ): Promise<CreateOrFindPublicationAttemptResult> {
    const existing = await this.findByIdempotency(input.workspaceId, input.idempotencyKey);
    if (existing) return { created: false, attempt: existing };

    try {
      const created = await this.client.publicationAttempt.create({
        data: {
          id: input.attemptId,
          workspaceId: input.workspaceId,
          contentVariantId: input.contentVariantId,
          channelId: input.channelId,
          connectionId: input.connectionId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          correlationId: input.correlationId,
          scheduledAt: input.scheduledAt ?? null,
        },
      });
      return { created: true, attempt: toDomain(created as PublicationRecord) };
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrent = await this.findByIdempotency(input.workspaceId, input.idempotencyKey);
      if (!concurrent) throw error;
      return { created: false, attempt: concurrent };
    }
  }

  public async createOrFindManualPublication(
    input: CreateManualPublicationInput,
  ): Promise<CreateOrFindPublicationAttemptResult> {
    const existing = await this.findByIdempotency(input.workspaceId, input.idempotencyKey);
    if (existing) return { created: false, attempt: existing };

    try {
      const created = await this.client.publicationAttempt.create({
        data: {
          id: input.attemptId,
          workspaceId: input.workspaceId,
          contentVariantId: input.contentVariantId,
          channelId: input.channelId,
          connectionId: input.connectionId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          correlationId: input.correlationId,
          status: "PUBLISHED",
          publishedAt: input.publishedAt,
        },
      });
      return { created: true, attempt: toDomain(created as PublicationRecord) };
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrent = await this.findByIdempotency(input.workspaceId, input.idempotencyKey);
      if (!concurrent) throw error;
      return { created: false, attempt: concurrent };
    }
  }

  public async findForWorkspace(input: {
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    attemptId: string;
  }): Promise<PublicationAttempt | null> {
    const record = await this.client.publicationAttempt.findFirst({
      where: { id: input.attemptId, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record as PublicationRecord) : null;
  }

  public async listLatestForVariants(input: {
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    variantIds: readonly string[];
  }): Promise<ReadonlyMap<string, PublicationAttempt>> {
    if (input.variantIds.length === 0) return new Map();
    const records = await this.client.publicationAttempt.findMany({
      where: { workspaceId: input.workspaceId, contentVariantId: { in: [...input.variantIds] } },
      // id breaks createdAt ties so "latest" is deterministic.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latest = new Map<string, PublicationAttempt>();
    for (const record of records) {
      const attempt = toDomain(record as PublicationRecord);
      if (!latest.has(attempt.contentVariantId)) latest.set(attempt.contentVariantId, attempt);
    }
    return latest;
  }

  public async markPublishing(input: {
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    attemptId: string;
  }): Promise<PublicationAttempt | null> {
    const updated = await this.client.publicationAttempt.updateMany({
      where: {
        id: input.attemptId,
        workspaceId: input.workspaceId,
        status: { in: ["QUEUED", "RETRYABLE_FAILURE"] },
      },
      data: { status: "PUBLISHING", attemptCount: { increment: 1 } },
    });
    if (updated.count === 0) return null;
    return this.findForWorkspace(input);
  }

  public async recordPublished(input: {
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    attemptId: string;
    externalId: string;
  }): Promise<PublicationAttempt> {
    const updated = await this.client.publicationAttempt.updateMany({
      where: { id: input.attemptId, workspaceId: input.workspaceId },
      data: {
        status: "PUBLISHED",
        externalId: input.externalId,
        terminalReason: null,
        publishedAt: new Date(),
      },
    });
    if (updated.count === 0) throw new Error("Publication attempt not found");
    const result = await this.findForWorkspace(input);
    if (!result) throw new Error("Publication attempt not found");
    return result;
  }

  public async recordFailure(input: {
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    attemptId: string;
    status: Extract<
      PublicationStatus,
      "retryable_failure" | "permanent_failure" | "unknown_outcome"
    >;
    reason: string;
  }): Promise<PublicationAttempt> {
    const updated = await this.client.publicationAttempt.updateMany({
      where: { id: input.attemptId, workspaceId: input.workspaceId },
      data: {
        status: input.status.toUpperCase() as
          | "RETRYABLE_FAILURE"
          | "PERMANENT_FAILURE"
          | "UNKNOWN_OUTCOME",
        terminalReason: input.reason.slice(0, 200),
      },
    });
    if (updated.count === 0) throw new Error("Publication attempt not found");
    const result = await this.findForWorkspace(input);
    if (!result) throw new Error("Publication attempt not found");
    return result;
  }
}
