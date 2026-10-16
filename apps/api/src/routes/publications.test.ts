import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentVariant } from "@money-maker/core/content/content";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://connection",
  accountId: "account-1",
  status: "active",
};
const channel = {
  id: "channel-1",
  workspaceId,
  connectionId: connection.id,
  kind: "threads" as const,
  label: "Threads",
  status: "active" as const,
  capabilities: {
    maxAssets: 1,
    requiresOrderedAssets: false,
    allowedMimeTypes: [],
    captionMaxLength: 500,
  },
};
const variant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: channel.id,
  offerSnapshotId: "snapshot-1",
  assetIds: [],
  caption: "Approved copy",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
  approval: {
    id: "approval-1",
    workspaceId,
    variantId: "variant-1",
    actorId: userId,
    assetChecksums: [],
    offerSnapshotId: "snapshot-1",
    publicationFingerprint: null,
    policyVersion: 1,
    decidedAt: new Date("2026-09-21T12:00:00.000Z"),
  },
};

const createFixture = (currentVariant: ContentVariant = variant) => {
  const attempt: PublicationAttempt = {
    attemptId: "11111111-1111-4111-8111-111111111111",
    workspaceId,
    contentVariantId: variant.id,
    channelId: channel.id,
    connectionId: connection.id,
    idempotencyKey: "request-1",
    requestFingerprint: "fingerprint",
    correlationId: "correlation-1",
    status: "queued",
    attemptCount: 0,
    createdAt: new Date("2026-09-21T12:00:00.000Z"),
    updatedAt: new Date("2026-09-21T12:00:00.000Z"),
  };
  const attempts: PublicationAttemptRepository = {
    listLatestForVariants: async () => new Map(),
    createOrFindByIdempotency: vi.fn(async () => ({ created: true, attempt })),
    createOrFindManualPublication: vi.fn(async () => ({ created: true, attempt })),
    findForWorkspace: vi.fn(async () => attempt),
    markPublishing: vi.fn(async () => attempt),
    recordPublished: vi.fn(async () => attempt),
    recordFailure: vi.fn(async () => attempt),
  };
  const queue = {
    enqueue: vi.fn(async (_job: unknown) => ({
      id: "job-1",
      workspaceId,
      name: "publish_content",
      payload: { version: 1 as const, workspaceId, identifiers: { attemptId: attempt.attemptId } },
      idempotencyKey: "publish-content:1",
      attemptCount: 0,
      maxAttempts: 3,
    })),
  };
  const dependencies = {
    invitation: {} as ApiDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({
        workspaceId,
        userId,
        role: "owner" as const,
        status: "active" as const,
      }),
      addMembership: async () => undefined,
    },
    contentRepository: {
      findVariantForWorkspace: async () => currentVariant,
      findContentItemForWorkspace: async () => ({ id: "content-1", offerId: "offer-1" }),
    } as unknown as ApiDependencies["contentRepository"],
    channelRepository: {
      findForWorkspace: async () => channel,
    } as unknown as ApiDependencies["channelRepository"],
    providerConnections: {
      findForWorkspace: async () => connection,
    } as unknown as ApiDependencies["providerConnections"],
    publicationAttempts: attempts,
    jobQueue: queue as unknown as ApiDependencies["jobQueue"],
    authenticate: async () => ({ userId, verifiedEmail: "owner@example.com" }),
  } as ApiDependencies;
  return { dependencies, attempts, queue };
};

describe("publication routes", () => {
  it("blocks an unapproved variant before enqueueing", async () => {
    const fixture = createFixture({ ...variant, state: "draft" });
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/publications`,
      payload: { contentVariantId: variant.id, idempotencyKey: "request-1" },
    });
    expect(response.statusCode).toBe(409);
    expect(fixture.queue.enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates a durable attempt and enqueues only identifiers", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/publications`,
      payload: { contentVariantId: variant.id, idempotencyKey: "request-1" },
    });
    expect(response.statusCode).toBe(202);
    expect(fixture.attempts.createOrFindByIdempotency).toHaveBeenCalled();
    expect(fixture.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "publish_content" }),
    );
    expect(JSON.stringify(fixture.queue.enqueue.mock.calls[0]?.[0])).not.toContain("Approved copy");
    await app.close();
  });

  it("blocks editorial publication before creating an attempt", async () => {
    const fixture = createFixture();
    (
      fixture.dependencies.contentRepository as unknown as {
        findContentItemForWorkspace: () => Promise<unknown>;
      }
    ).findContentItemForWorkspace = async () => ({ id: "content-1", offerId: null });
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/publications`,
      payload: { contentVariantId: variant.id, idempotencyKey: "request-1" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "EDITORIAL_PUBLICATION_NOT_ENABLED" } });
    expect(fixture.queue.enqueue).not.toHaveBeenCalled();
    expect(fixture.attempts.createOrFindByIdempotency).not.toHaveBeenCalled();
    await app.close();
  });
});
