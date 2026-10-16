import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProviderConnection } from "../providers/provider-connection.js";
import {
  createQueuedPublicationAttempt,
  type PublicationAttempt,
  type PublicationAttemptRepository,
} from "./publication.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const connection = createProviderConnection({
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://workspace/pfm",
  accountId: "account-1",
});

const queuedAttempt: PublicationAttempt = {
  attemptId: "attempt-1",
  workspaceId,
  contentVariantId: "variant-1",
  channelId: "channel-1",
  connectionId: connection.id,
  idempotencyKey: "idempotency-1",
  requestFingerprint: "sha256:fingerprint",
  correlationId: "correlation-1",
  status: "queued",
  attemptCount: 0,
  createdAt: new Date("2026-09-21T12:00:00.000Z"),
  updatedAt: new Date("2026-09-21T12:00:00.000Z"),
};

const repository = (): PublicationAttemptRepository => ({
  listLatestForVariants: async () => new Map(),
  createOrFindByIdempotency: vi.fn(async () => ({ created: true, attempt: queuedAttempt })),
  createOrFindManualPublication: vi.fn(async () => ({ created: true, attempt: queuedAttempt })),
  findForWorkspace: vi.fn(async () => queuedAttempt),
  markPublishing: vi.fn(async () => queuedAttempt),
  recordPublished: vi.fn(async () => queuedAttempt),
  recordFailure: vi.fn(async () => queuedAttempt),
});

const command = (
  overrides: Partial<Parameters<typeof createQueuedPublicationAttempt>[0]["command"]> = {},
) => ({
  attemptId: "attempt-1",
  workspaceId,
  contentVariantId: "variant-1",
  channelId: "channel-1",
  connection,
  approval: "approved" as const,
  idempotencyKey: "idempotency-1",
  requestFingerprint: "sha256:fingerprint",
  correlationId: "correlation-1",
  ...overrides,
});

describe("durable approval-gated publication", () => {
  it("rejects drafts before creating an attempt", async () => {
    const attempts = repository();
    await expect(
      createQueuedPublicationAttempt({
        command: command({ approval: "draft" }),
        attempts,
      }),
    ).rejects.toThrow("content_not_approved");
    expect(attempts.createOrFindByIdempotency).not.toHaveBeenCalled();
  });

  it("rejects a connection from another workspace", async () => {
    const attempts = repository();
    await expect(
      createQueuedPublicationAttempt({
        command: command({
          connection: createProviderConnection({
            id: "other-connection",
            workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
            provider: "post_for_me",
            mode: "api_key",
            secretReference: "secret://workspace/other",
            accountId: "account-2",
          }),
        }),
        attempts,
      }),
    ).rejects.toThrow("provider_connection_forbidden");
  });

  it("creates one queued attempt and delegates idempotency to persistence", async () => {
    const attempts = repository();
    await expect(createQueuedPublicationAttempt({ command: command(), attempts })).resolves.toEqual(
      { created: true, attempt: queuedAttempt },
    );
    expect(attempts.createOrFindByIdempotency).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      workspaceId,
      contentVariantId: "variant-1",
      channelId: "channel-1",
      connectionId: "connection-1",
      idempotencyKey: "idempotency-1",
      requestFingerprint: "sha256:fingerprint",
      correlationId: "correlation-1",
    });
  });

  it("returns the existing attempt when persistence deduplicates the key", async () => {
    const attempts: PublicationAttemptRepository = {
      listLatestForVariants: async () => new Map(),
      createOrFindByIdempotency: vi.fn(async () => ({ created: false, attempt: queuedAttempt })),
      createOrFindManualPublication: vi.fn(async () => ({
        created: false,
        attempt: queuedAttempt,
      })),
      findForWorkspace: vi.fn(async () => queuedAttempt),
      markPublishing: vi.fn(async () => queuedAttempt),
      recordPublished: vi.fn(async () => queuedAttempt),
      recordFailure: vi.fn(async () => queuedAttempt),
    };
    await expect(
      createQueuedPublicationAttempt({ command: command(), attempts }),
    ).resolves.toMatchObject({ created: false, attempt: queuedAttempt });
  });
});
