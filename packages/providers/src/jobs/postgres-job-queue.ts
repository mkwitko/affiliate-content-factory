import type { WorkspaceId } from "@money-maker/contracts";
import {
  type ClaimedJob,
  type EnqueueJobInput,
  HEAVY_JOB_NAMES,
  JobClaimLostError,
  type JobIdentifierPayload,
  type JobQueue,
  LOCAL_AI_JOB_NAMES,
  parseVersionedIdentifierPayload,
  type QueuedJob,
} from "@money-maker/core/jobs/job";
import type { FailedJob, JobCount, JobStats } from "@money-maker/core/jobs/job-stats";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "../database/client.js";

const jobName = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const maximumAttempts = 12;

type CandidateJobRow = {
  id: string;
  workspaceId: string;
  name: string;
  payload: unknown;
  idempotencyKey: string;
  attemptCount: number;
};

type ClaimedJobRow = CandidateJobRow & { leaseToken: string };

const assertEnqueueInput = (input: EnqueueJobInput) => {
  if (!jobName.test(input.name)) throw new Error("Job name is invalid.");
  if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 200) {
    throw new Error("Job idempotency key is invalid.");
  }
  if (
    !Number.isSafeInteger(input.attemptPolicy.maxAttempts) ||
    input.attemptPolicy.maxAttempts < 1 ||
    input.attemptPolicy.maxAttempts > maximumAttempts
  ) {
    throw new Error(`Job maxAttempts must be between 1 and ${maximumAttempts}.`);
  }
  return parseVersionedIdentifierPayload(input.payload);
};

const identifiersOf = (payload: unknown): Record<string, string> => {
  try {
    return { ...parseVersionedIdentifierPayload(payload).identifiers };
  } catch {
    return {};
  }
};

const ensureClaimHeld = (updatedCount: number): void => {
  if (updatedCount !== 1) throw new JobClaimLostError();
};

// Any fixed 64-bit key: every claim transaction takes it, so heavy-job checks never race.
const CLAIM_LOCK_KEY = 7_140_392_001;

/**
 * PostgreSQL queue adapter using SKIP LOCKED claims and lease-token ownership. Within each
 * exclusive set (heavy renders; local-AI model jobs) at most one job holds a live lease at a
 * time, across every worker process. The sets do not block each other.
 */
export class PostgresJobQueue implements JobQueue, JobStats {
  private readonly exclusiveJobSets: readonly (readonly string[])[];

  public constructor(
    private readonly client: DatabaseClient,
    options: Readonly<{
      exclusiveJobSets?: readonly (readonly string[])[];
    }> = {},
  ) {
    this.exclusiveJobSets = options.exclusiveJobSets ?? [HEAVY_JOB_NAMES, LOCAL_AI_JOB_NAMES];
  }

  public async enqueue(input: EnqueueJobInput): Promise<QueuedJob> {
    const payload = assertEnqueueInput(input);
    const job = await this.client.job.upsert({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: payload.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      create: {
        workspaceId: payload.workspaceId,
        name: input.name,
        payload,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.attemptPolicy.maxAttempts,
        ...(input.availableAt ? { availableAt: input.availableAt } : {}),
      },
      update: {},
    });
    return {
      id: job.id,
      workspaceId: payload.workspaceId,
      name: job.name,
      payload: parseVersionedIdentifierPayload(job.payload),
      idempotencyKey: job.idempotencyKey,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
    };
  }

  public async claim(input: {
    workerId: string;
    leaseDurationMs: number;
    names: readonly string[];
    workspaceId?: WorkspaceId;
    preferNames?: readonly string[];
  }): Promise<ClaimedJob | null> {
    if (input.workerId.trim().length === 0) throw new Error("Worker id is required.");
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new Error("Job lease duration must be a positive integer.");
    }
    // Deny by default: a worker claims only what it registered, never "everything".
    if (input.names.length === 0 || input.names.some((name) => !jobName.test(name))) {
      throw new Error("Job names are invalid.");
    }
    const names = [...input.names];
    const exclusiveSets = this.exclusiveJobSets.filter((set) => set.length > 0);
    // A home claim (workspaceId set) only waits for its own workspace: one workspace's home
    // machine must not hold up another's (ADR 0012).
    const sameWorkspace = input.workspaceId
      ? Prisma.sql`AND running.workspace_id = ${input.workspaceId}::uuid`
      : Prisma.empty;
    const exclusiveFree = exclusiveSets.map(
      (set) => Prisma.sql`(
          NOT (name = ANY(${[...set]}::text[]))
          OR NOT EXISTS (
            SELECT 1 FROM "jobs" AS running
            WHERE running.name = ANY(${[...set]}::text[])
              AND running.status = 'RUNNING'::"JobStatus"
              AND running.lease_expires_at > CURRENT_TIMESTAMP
              ${sameWorkspace}
          )
        )`,
    );
    return this.client.$transaction(async (transaction) => {
      if (exclusiveSets.length > 0)
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_KEY}::bigint)`,
        );
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "jobs"
        SET status = 'FAILED'::"JobStatus",
            lease_token = NULL,
            lease_expires_at = NULL,
            terminal_reason = 'attempts_exhausted',
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'RUNNING'::"JobStatus"
          AND lease_expires_at <= CURRENT_TIMESTAMP
          AND attempt_count >= max_attempts
      `);

      const candidates = await transaction.$queryRaw<CandidateJobRow[]>(Prisma.sql`
        SELECT id,
               workspace_id AS "workspaceId",
               name,
               payload,
               idempotency_key AS "idempotencyKey",
               attempt_count AS "attemptCount"
        FROM "jobs"
        WHERE (
          (status = 'PENDING' AND available_at <= CURRENT_TIMESTAMP)
          OR (status = 'RUNNING' AND lease_expires_at <= CURRENT_TIMESTAMP)
        )
        AND attempt_count < max_attempts
        AND name = ANY(${names}::text[])
        AND ${input.workspaceId ? Prisma.sql`workspace_id = ${input.workspaceId}::uuid` : Prisma.sql`TRUE`}
        AND ${exclusiveFree.length > 0 ? Prisma.join(exclusiveFree, " AND ") : Prisma.sql`TRUE`}
        ORDER BY ${
          input.preferNames?.length
            ? Prisma.sql`(name = ANY(${[...input.preferNames]}::text[])) DESC,`
            : Prisma.empty
        } available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const candidate = candidates[0];
      if (!candidate) return null;

      let payload: JobIdentifierPayload;
      try {
        payload = parseVersionedIdentifierPayload(candidate.payload);
      } catch {
        await transaction.job.update({
          where: { id: candidate.id },
          data: {
            status: "FAILED",
            leaseToken: null,
            leaseExpiresAt: null,
            terminalReason: "malformed_payload",
          },
        });
        return null;
      }
      if (payload.workspaceId !== candidate.workspaceId) {
        await transaction.job.update({
          where: { id: candidate.id },
          data: {
            status: "FAILED",
            leaseToken: null,
            leaseExpiresAt: null,
            terminalReason: "malformed_payload",
          },
        });
        return null;
      }

      const leaseToken = crypto.randomUUID();
      const claimed = await transaction.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
        UPDATE "jobs"
        SET status = 'RUNNING'::"JobStatus",
            attempt_count = attempt_count + 1,
            lease_token = ${leaseToken},
            lease_expires_at = CURRENT_TIMESTAMP + (${input.leaseDurationMs} * INTERVAL '1 millisecond'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${candidate.id}::uuid
        RETURNING id,
                  workspace_id AS "workspaceId",
                  name,
                  payload,
                  lease_token AS "leaseToken",
                  idempotency_key AS "idempotencyKey",
                  attempt_count AS "attemptCount"
      `);
      const job = claimed[0];
      if (!job) throw new Error("Claimed job was not found.");
      return { ...job, workspaceId: payload.workspaceId };
    });
  }

  public async countByStatus(input: {
    workspaceId: WorkspaceId;
    names?: readonly string[];
  }): Promise<readonly JobCount[]> {
    const groups = await this.client.job.groupBy({
      by: ["name", "status"],
      where: {
        workspaceId: input.workspaceId,
        ...(input.names ? { name: { in: [...input.names] } } : {}),
      },
      _count: { _all: true },
    });
    return groups.map((group) => ({
      name: group.name,
      status: group.status,
      count: group._count._all,
    }));
  }

  public async listFailed(input: {
    workspaceId: WorkspaceId;
    since: Date;
    take: number;
  }): Promise<readonly FailedJob[]> {
    const rows = await this.client.job.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: "FAILED",
        updatedAt: { gte: input.since },
      },
      orderBy: { updatedAt: "desc" },
      take: Math.min(input.take, 100),
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      idempotencyKey: row.idempotencyKey,
      terminalReason: row.terminalReason,
      updatedAt: row.updatedAt,
      attemptCount: row.attemptCount,
      identifiers: identifiersOf(row.payload),
    }));
  }

  public async revive(input: { workspaceId: WorkspaceId; jobId: string }): Promise<boolean> {
    const changed = await this.client.$executeRaw(Prisma.sql`
      UPDATE "jobs"
      SET status = 'PENDING'::"JobStatus",
          attempt_count = 0,
          available_at = CURRENT_TIMESTAMP,
          terminal_reason = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.jobId}::uuid
        AND workspace_id = ${input.workspaceId}::uuid
        AND status = 'FAILED'::"JobStatus"
    `);
    return changed === 1;
  }

  public async takeLease(input: {
    id: string;
    workspaceId: WorkspaceId;
    leaseToken: string;
  }): Promise<ClaimedJob | null> {
    const rows = await this.client.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
      UPDATE "jobs"
      SET lease_token = ${crypto.randomUUID()},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.id}::uuid
        AND workspace_id = ${input.workspaceId}::uuid
        AND status = 'RUNNING'::"JobStatus"
        AND lease_token = ${input.leaseToken}
        AND lease_expires_at > CURRENT_TIMESTAMP
      RETURNING id,
                workspace_id AS "workspaceId",
                name,
                payload,
                lease_token AS "leaseToken",
                idempotency_key AS "idempotencyKey",
                attempt_count AS "attemptCount"
    `);
    const row = rows[0];
    return row ? { ...row, workspaceId: input.workspaceId } : null;
  }

  public async complete(input: {
    id: string;
    workspaceId: string;
    leaseToken: string;
  }): Promise<void> {
    const updated = await this.client.job.updateMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        status: "RUNNING",
        leaseToken: input.leaseToken,
      },
      data: {
        status: "COMPLETED",
        leaseToken: null,
        leaseExpiresAt: null,
        terminalReason: null,
      },
    });
    ensureClaimHeld(updated.count);
  }

  public async retry(input: {
    id: string;
    workspaceId: string;
    leaseToken: string;
    reason: string;
    retryAt?: Date;
  }): Promise<void> {
    const updated = await this.client.$executeRaw(Prisma.sql`
      UPDATE "jobs"
      SET status = CASE WHEN attempt_count >= max_attempts THEN 'FAILED'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
          available_at = CASE
            WHEN attempt_count >= max_attempts THEN available_at
            WHEN ${input.retryAt ?? null}::timestamp IS NOT NULL THEN ${input.retryAt ?? null}::timestamp
            ELSE CURRENT_TIMESTAMP + ((1000 * LEAST(attempt_count, 5)) + FLOOR(RANDOM() * 250)) * INTERVAL '1 millisecond'
          END,
          lease_token = NULL,
          lease_expires_at = NULL,
          terminal_reason = CASE WHEN attempt_count >= max_attempts THEN 'attempts_exhausted' ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.id}::uuid
        AND workspace_id = ${input.workspaceId}::uuid
        AND status = 'RUNNING'::"JobStatus"
        AND lease_token = ${input.leaseToken}
    `);
    ensureClaimHeld(updated);
  }

  public async failPermanently(input: {
    id: string;
    workspaceId: string;
    leaseToken: string;
    reason: string;
  }): Promise<void> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 200)
      throw new Error("Job failure reason is invalid.");
    const updated = await this.client.job.updateMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        status: "RUNNING",
        leaseToken: input.leaseToken,
      },
      data: {
        status: "FAILED",
        leaseToken: null,
        leaseExpiresAt: null,
        terminalReason: reason,
      },
    });
    ensureClaimHeld(updated.count);
  }
}
