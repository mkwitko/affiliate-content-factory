import { parseWorkspaceId } from "@money-maker/contracts";
import { RetryLaterJobError } from "@money-maker/core/jobs/job";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { SocialPublisher } from "@money-maker/core/publishing/social-publisher";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconcilePublicationHandler } from "./reconcile-publication.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const attempt: PublicationAttempt = {
  attemptId: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  contentVariantId: "variant-1",
  channelId: "channel-1",
  connectionId: "connection-1",
  idempotencyKey: "key-1",
  requestFingerprint: "fingerprint",
  correlationId: "correlation-1",
  status: "unknown_outcome",
  attemptCount: 1,
  createdAt: new Date("2026-09-21T12:00:00.000Z"),
  updatedAt: new Date("2026-09-21T12:00:00.000Z"),
};
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://connection",
  accountId: "account-1",
  status: "active",
};

const createAttempts = (): PublicationAttemptRepository => ({
  listLatestForVariants: async () => new Map(),
  createOrFindByIdempotency: vi.fn(),
  createOrFindManualPublication: vi.fn(),
  findForWorkspace: vi.fn(async () => attempt),
  markPublishing: vi.fn(),
  recordPublished: vi.fn(async () => ({
    ...attempt,
    status: "published" as const,
    externalId: "post-1",
  })),
  recordFailure: vi.fn(async () => attempt),
});

const job = {
  payload: { version: 1 as const, workspaceId, identifiers: { attemptId: attempt.attemptId } },
};

describe("reconcile_publication handler", () => {
  it("records a unique provider match as published", async () => {
    const attempts = createAttempts();
    const publisher: SocialPublisher = {
      publish: vi.fn(),
      reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
    };
    const handler = createReconcilePublicationHandler({
      attempts,
      connections: { findForWorkspace: vi.fn(async () => connection) },
      publisher,
    });
    await expect(handler(job)).resolves.toBeUndefined();
    expect(attempts.recordPublished).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      externalId: "post-1",
    });
  });

  it("records a permanent failure when the provider reports the post failed, without throwing", async () => {
    const attempts = createAttempts();
    const publisher: SocialPublisher = {
      publish: vi.fn(),
      reconcile: vi.fn(async () => ({
        externalId: "post-1",
        status: "failed" as const,
        failureReason: "Media rejected",
      })),
    };
    const handler = createReconcilePublicationHandler({
      attempts,
      connections: { findForWorkspace: vi.fn(async () => connection) },
      publisher,
    });
    await expect(handler(job)).resolves.toBeUndefined();
    expect(attempts.recordPublished).not.toHaveBeenCalled();
    expect(attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "permanent_failure",
      reason: "provider_post_failed: Media rejected",
    });
  });

  it("keeps a still-processing provider result unknown", async () => {
    const attempts = createAttempts();
    const publisher: SocialPublisher = {
      publish: vi.fn(),
      reconcile: vi.fn(async () => ({ externalId: "post-1", status: "queued" as const })),
    };
    const handler = createReconcilePublicationHandler({
      attempts,
      connections: { findForWorkspace: vi.fn(async () => connection) },
      publisher,
    });
    await expect(handler(job)).rejects.toThrow("provider_still_processing");
    expect(attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "unknown_outcome",
      reason: "provider_still_processing",
    });
  });

  describe("still-processing backoff", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const stillProcessingPublisher: SocialPublisher = {
      publish: vi.fn(),
      reconcile: vi.fn(async () => ({ externalId: "post-1", status: "queued" as const })),
    };

    const delayCases: ReadonlyArray<[attemptCount: number | undefined, expectedDelayMs: number]> = [
      [undefined, 15_000], // no attemptCount on the job: treated as the first attempt
      [1, 15_000],
      [2, 30_000],
      [3, 60_000],
      [7, 15 * 60_000], // 15s * 2^6 = 960s, capped at the 15 min ceiling
      [12, 15 * 60_000], // stays capped for later attempts
    ];

    it.each(delayCases)(
      "schedules attemptCount %s to retry after %dms, capped at 15 min",
      async (attemptCount, expectedDelayMs) => {
        const attempts = createAttempts();
        const handler = createReconcilePublicationHandler({
          attempts,
          connections: { findForWorkspace: vi.fn(async () => connection) },
          publisher: stillProcessingPublisher,
        });

        const rejection = handler(attemptCount === undefined ? job : { ...job, attemptCount });
        await expect(rejection).rejects.toBeInstanceOf(RetryLaterJobError);
        await rejection.catch((error: RetryLaterJobError) => {
          expect(error.retryAt).toEqual(new Date(Date.now() + expectedDelayMs));
        });
      },
    );
  });
});
