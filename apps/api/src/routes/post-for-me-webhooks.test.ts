import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connectionId = "connection-1";
const attemptId = "22222222-2222-4222-8222-222222222222";

const createFixture = () => {
  const secrets = new Map([
    ["secret://webhook", "webhook-secret"],
    ["secret://api", "api-secret"],
  ]);
  const enqueue = vi.fn(async (job: unknown) => job as never);
  const inboxKeys = new Set<string>();
  const providerConnections = {
    create: async (connection: never) => ({ ok: true as const, connection }),
    findAllForWorkspace: async () => [],
    findForWorkspace: async () => ({
      id: connectionId,
      workspaceId,
      provider: "post_for_me" as const,
      mode: "api_key" as const,
      secretReference: "secret://api",
      accountId: "account-1",
      status: "active" as const,
      webhookSecretReference: "secret://webhook",
    }),
    findById: async () => ({
      id: connectionId,
      workspaceId,
      provider: "post_for_me" as const,
      mode: "api_key" as const,
      secretReference: "secret://api",
      accountId: "account-1",
      status: "active" as const,
      webhookSecretReference: "secret://webhook",
    }),
    configureWebhook: async () => null,
    revoke: async () => undefined,
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
    providerConnections,
    secretStoreForWorkspace: () => ({
      put: async ({ reference, secret }: { reference: string; secret: string }) =>
        void secrets.set(reference, secret),
      get: async (reference: string) => secrets.get(reference) ?? null,
      delete: async (reference: string) => void secrets.delete(reference),
    }),
    postForMeClient: {
      createSocialPost: vi.fn(),
      findSocialPostByExternalId: vi.fn(),
      createWebhook: vi.fn(async () => ({ id: "webhook-1", secret: "new-secret" })),
      getSocialPostMetrics: async () => null,
    },
    publicApiUrl: "https://app.test",
    webhookInbox: {
      createIfAbsent: vi.fn(async ({ deliveryKey }: { deliveryKey: string }) => {
        const created = !inboxKeys.has(deliveryKey);
        inboxKeys.add(deliveryKey);
        return { created };
      }),
    },
    jobQueue: { enqueue },
    authenticate: async () => ({ userId, verifiedEmail: "owner@example.com" }),
  } as unknown as ApiDependencies;
  return { dependencies, enqueue };
};

describe("Post For Me webhook routes", () => {
  it("rejects an invalid shared secret", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/v1/provider-webhooks/post-for-me/${connectionId}`,
      headers: { "Post-For-Me-Webhook-Secret": "wrong" },
      payload: { event_type: "social.post.result.created", data: { external_id: attemptId } },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("acknowledges duplicates and enqueues reconciliation once", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const input = {
      method: "POST" as const,
      url: `/v1/provider-webhooks/post-for-me/${connectionId}`,
      headers: { "Post-For-Me-Webhook-Secret": "webhook-secret" },
      payload: {
        event_type: "social.post.result.created",
        data: { event_id: "delivery-1", external_id: attemptId },
      },
    };
    expect((await app.inject(input)).statusCode).toBe(202);
    expect((await app.inject(input)).statusCode).toBe(202);
    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
