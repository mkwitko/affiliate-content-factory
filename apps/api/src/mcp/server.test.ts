import { describe, expect, it } from "vitest";
import {
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId,
} from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import type {
  InvitationDependencies,
  InvitationRecord,
} from "@money-maker/core/identity/invitation-repository";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { PostForMeClient } from "@money-maker/providers/post-for-me/client";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { createMcpServer, mcpServerInstructions, type McpDependencies } from "./server.js";
import { oauthScopes } from "../auth/oidc-token-verifier.js";

const ownerId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const otherUserId = parseUserId("84d55b67-e059-4942-8191-b42a693a3525");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");
const now = new Date("2026-09-21T12:00:00.000Z");

const membership = (
  userId: UserId,
  targetWorkspaceId: WorkspaceId = workspaceId,
  status: WorkspaceMembership["status"] = "active",
): WorkspaceMembership => ({
  userId,
  workspaceId: targetWorkspaceId,
  role: "owner",
  status,
});

const createDependencies = (
  options: Readonly<{
    authenticatedUserId?: UserId | null;
    membership?: WorkspaceMembership | null;
  }> = {},
): McpDependencies &
  Readonly<{
    providerRecords: ProviderConnection[];
    storedSecrets: Map<string, string>;
    storedInvitations: InvitationRecord[];
    storedAuditEvents: ReadonlyArray<Readonly<{ id: string; invitationId: string }>>;
  }> => {
  const storedInvitations: InvitationRecord[] = [];
  const storedAuditEvents: Array<Readonly<{ id: string; invitationId: string }>> = [];
  const providerConnections: ProviderConnection[] = [];
  const secrets = new Map<string, string>();
  const providerConnectionRepository: ProviderConnectionRepository = {
    create: async (connection) => {
      providerConnections.push(connection);
      return { ok: true, connection };
    },
    findAllForWorkspace: async ({ workspaceId: targetWorkspaceId }) =>
      providerConnections.filter((connection) => connection.workspaceId === targetWorkspaceId),
    findForWorkspace: async ({ workspaceId: targetWorkspaceId, connectionId }) =>
      providerConnections.find(
        (connection) =>
          connection.workspaceId === targetWorkspaceId && connection.id === connectionId,
      ) ?? null,
    revoke: async ({ workspaceId: targetWorkspaceId, connectionId }) => {
      const connection = providerConnections.find(
        (candidate) => candidate.workspaceId === targetWorkspaceId && candidate.id === connectionId,
      );
      if (connection) {
        providerConnections[providerConnections.indexOf(connection)] = {
          ...connection,
          status: "revoked",
        };
      }
    },
  };
  const secretStore: SecretStore = {
    put: async ({ reference, secret }) => void secrets.set(reference, secret),
    get: async (reference) => secrets.get(reference) ?? null,
    delete: async (reference) => void secrets.delete(reference),
  };
  const invitation: InvitationDependencies = {
    memberships: {
      findByUserAndWorkspace: async ({ userId, workspaceId: targetWorkspaceId }) =>
        options.membership === undefined
          ? userId === ownerId && targetWorkspaceId === workspaceId
            ? membership(userId, targetWorkspaceId)
            : null
          : options.membership,
      ensureMembership: async () => "created",
    },
    invitations: {
      create: async (input, auditEvent) => {
        const record: InvitationRecord = {
          id: "invitation-1",
          status: "pending",
          ...input,
        };
        storedInvitations.push(record);
        const auditEventId = "audit-event-1";
        storedAuditEvents.push({ id: auditEventId, invitationId: record.id });
        expect(auditEvent).toEqual({
          action: "workspace.invitation.created",
          workspaceId,
          actorUserId: ownerId,
        });
        return { invitation: record, auditId: auditEventId };
      },
      findByTokenHash: async () => null,
      acceptPending: async () => "already_accepted",
    },
    audit: { record: async () => "audit-event-1" },
    clock: { now: () => now },
    tokens: { generate: () => "new-invitation-token" },
    tokenHasher: { hash: async (token) => `stored-hash:${token}` },
  };
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace Alpha" }),
    findByIdForMember: async ({ workspaceId: targetWorkspaceId, userId }) =>
      targetWorkspaceId === workspaceId && userId === ownerId
        ? { id: workspaceId, name: "Workspace Alpha" }
        : null,
    findMembership: async ({ workspaceId: targetWorkspaceId, userId }) =>
      targetWorkspaceId === workspaceId && userId === ownerId
        ? (options.membership ?? { workspaceId, userId, role: "owner", status: "active" })
        : null,
    addMembership: async () => undefined,
  };

  const postForMeClient: PostForMeClient = {
    listSocialAccounts: async () => [
      {
        id: "acc-exampleshop-casa",
        platform: "instagram",
        username: "exampleshop.home",
        status: "active",
      },
    ],
    createSocialPost: async () => {
      throw new Error("not_implemented");
    },
    findSocialPostByExternalId: async () => {
      throw new Error("not_implemented");
    },
    getSocialPostMetrics: async () => null,
    createWebhook: async () => {
      throw new Error("not_implemented");
    },
  };

  return {
    authenticate: async () =>
      options.authenticatedUserId === null
        ? null
        : {
            userId: options.authenticatedUserId ?? ownerId,
            verifiedEmail: "owner@example.com",
            scopes: new Set(oauthScopes),
          },
    invitation,
    workspaces,
    providerConnections: providerConnectionRepository,
    secretStore,
    postForMeClient,
    providerRecords: providerConnections,
    storedSecrets: secrets,
    storedInvitations,
    storedAuditEvents,
  };
};

const callTool = async (server: ReturnType<typeof createMcpServer>, name: string, args: unknown) =>
  server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

describe("MCP workspace tools", () => {
  it("advertises server instructions and standard structured tool results", async () => {
    const server = createMcpServer(createDependencies());

    const initialized = await server.handle({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(initialized).toMatchObject({
      result: {
        serverInfo: { name: "money-maker" },
        instructions: expect.stringContaining("Never publish a draft"),
        capabilities: { tools: { listChanged: true } },
      },
    });

    const called = await callTool(server, "get_workspace", { workspaceId });
    expect(called).toMatchObject({
      result: {
        content: [{ type: "text" }],
        structuredContent: { workspace: { id: workspaceId } },
      },
    });
  });

  it("lists a read-only workspace tool and an explicitly side-effecting invitation tool", async () => {
    const server = createMcpServer(createDependencies());

    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
    const tools = (response.result?.tools ?? []) as Array<Record<string, unknown>>;
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "get_workspace",
          description: expect.stringContaining("Read one workspace"),
          inputSchema: expect.objectContaining({ type: "object" }),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "create_invitation",
          description: expect.stringContaining("Create an invitation"),
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({ name: "create_provider_connection" }),
        expect.objectContaining({ name: "create_content_variant" }),
        expect.objectContaining({
          name: "analyze_offer_price_history",
          description: expect.stringContaining("Sparse, stale, unavailable"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "discover_market_radar",
          description: expect.stringContaining("views indicate content activity"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "build_opportunity_brief",
          description: expect.stringContaining("never estimates sales or profit"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "create_creative_brief",
          description: expect.stringContaining("Does not generate or publish content"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "list_recent_owned_long_forms",
          description: expect.stringContaining("instead of an internal render ID"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "search_youtube_sources",
          description: expect.stringContaining("does not prove ownership"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "inspect_source_transcript",
          description: expect.stringContaining("untrusted source content"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "inspect_youtube_source",
          description: expect.stringContaining("metadata only"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "refine_owned_clip_time_range",
          description: expect.stringContaining("complete aligned words"),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "approve_content",
          annotations: expect.objectContaining({
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          }),
        }),
        expect.objectContaining({
          name: "publish_content",
          annotations: expect.objectContaining({
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          }),
        }),
        expect.objectContaining({
          name: "import_asset_from_url",
          annotations: expect.objectContaining({ destructiveHint: false, openWorldHint: true }),
        }),
        expect.objectContaining({ name: "reject_content" }),
        expect.objectContaining({ name: "list_provider_connections" }),
        expect.objectContaining({ name: "revoke_provider_connection" }),
        expect.objectContaining({
          name: "get_profile",
          outputSchema: expect.objectContaining({ required: ["id"] }),
          _meta: {
            "moneymaker.example.com/risk": "read",
            "openai/profile": true,
            securitySchemes: [{ type: "oauth2", scopes: [] }],
          },
        }),
      ]),
    );
  });

  it("tells MCP clients to route by user goal and inspect the live catalog", () => {
    expect(mcpServerInstructions).toContain("Start with the user's goal");
    expect(mcpServerInstructions).toContain("live tools/list");
    expect(mcpServerInstructions).toContain("money-maker-operator");
  });

  it("denies a publish call when the authenticated token lacks publish scope", async () => {
    const dependencies = createDependencies();
    const server = createMcpServer({
      ...dependencies,
      authenticate: async () => ({
        userId: ownerId,
        verifiedEmail: "owner@example.com",
        scopes: new Set(["content:read"]),
      }),
    });

    const response = await callTool(server, "publish_content", {
      workspaceId,
      contentVariantId: "variant-1",
      idempotencyKey: "publish-1",
    });

    expect(response).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: "FORBIDDEN" } },
      },
    });
  });

  it("creates a manual offer for the authenticated workspace without accepting actor input", async () => {
    const storedOffers: Offer[] = [];
    const dependencies = createDependencies();
    const offerRepository: OfferRepository = {
      create: async (offer) => {
        storedOffers.push(offer);
        return offer;
      },
      findForWorkspace: async () => null,
      addSnapshot: async () => null,
      activate: async () => null,
      reject: async () => null,
    };
    const server = createMcpServer({
      ...dependencies,
      offerRepository,
      audit: { record: async () => "audit-offer-1" },
    });

    const response = await callTool(server, "create_offer", {
      workspaceId,
      listingUrl: "https://mercadolivre.example/item/1",
      affiliateUrl: "https://affiliate.example/item/1",
      title: "Example product",
      currentPrice: { amountMinor: 12990, currency: "BRL" },
    });

    expect(response).toMatchObject({
      result: { structuredContent: { offer: { workspaceId, state: "draft" } } },
    });
    expect(storedOffers).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain("actorId");
  });

  it("creates and lists a redacted provider connection without exposing secret material", async () => {
    const dependencies = createDependencies();
    const server = createMcpServer(dependencies);

    const created = await callTool(server, "create_provider_connection", {
      workspaceId,
      apiKey: "pfm_secret_test",
      instagramHandle: "exampleshop.home",
    });
    expect(created).toMatchObject({
      result: { structuredContent: { connection: { workspaceId } } },
    });
    expect(created.result?.structuredContent).not.toHaveProperty("apiKey");
    expect(JSON.stringify(created)).not.toContain("pfm_secret_test");
    expect(JSON.stringify(created)).not.toContain("secret://");

    const listed = await callTool(server, "list_provider_connections", { workspaceId });
    expect(listed).toMatchObject({
      result: { structuredContent: { connections: [{ workspaceId }] } },
    });
    expect(JSON.stringify(listed)).not.toContain("secret://");
    expect(dependencies.storedSecrets.size).toBe(1);
  });

  it("lets reviewers list but not create or revoke provider connections", async () => {
    const ownerDependencies = createDependencies();
    const ownerServer = createMcpServer(ownerDependencies);
    const created = await callTool(ownerServer, "create_provider_connection", {
      workspaceId,
      apiKey: "pfm_secret_test",
      instagramHandle: "exampleshop.home",
    });
    const createdContent = created.result?.structuredContent as Record<string, unknown> | undefined;
    const createdConnection = createdContent?.connection;
    if (
      !createdContent ||
      typeof createdConnection !== "object" ||
      createdConnection === null ||
      !("id" in createdConnection) ||
      typeof createdConnection.id !== "string"
    ) {
      throw new Error("Provider connection was not created.");
    }
    const connectionId = createdConnection.id;

    const reviewerDependencies = createDependencies({
      membership: { ...membership(ownerId), role: "reviewer" },
    });
    reviewerDependencies.providerRecords.push(...ownerDependencies.providerRecords);
    const reviewerServer = createMcpServer(reviewerDependencies);

    const listed = await callTool(reviewerServer, "list_provider_connections", { workspaceId });
    expect(listed).toMatchObject({
      result: { structuredContent: { connections: [{ workspaceId }] } },
    });

    const rejectedCreate = await callTool(reviewerServer, "create_provider_connection", {
      workspaceId,
      apiKey: "pfm_secret_test",
      instagramHandle: "exampleshop.home",
    });
    expect(rejectedCreate).toMatchObject({
      result: { structuredContent: { error: { code: "FORBIDDEN" } } },
    });

    const rejectedRevoke = await callTool(reviewerServer, "revoke_provider_connection", {
      workspaceId,
      connectionId,
    });
    expect(rejectedRevoke).toMatchObject({
      result: { structuredContent: { error: { code: "FORBIDDEN" } } },
    });
  });

  it("returns an authorized workspace without causing a mutation", async () => {
    const server = createMcpServer(createDependencies());

    const response = await callTool(server, "get_workspace", { workspaceId });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ workspace: { id: workspaceId, name: "Workspace Alpha" } }),
          },
        ],
        structuredContent: { workspace: { id: workspaceId, name: "Workspace Alpha" } },
      },
    });
  });

  it("rejects malformed tool arguments with a stable safe error", async () => {
    const server = createMcpServer(createDependencies());

    const response = await callTool(server, "get_workspace", { workspaceId: "not-a-uuid" });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
      },
    });
  });

  it("does not disclose an unauthorized workspace", async () => {
    const server = createMcpServer(createDependencies());

    const response = await callTool(server, "get_workspace", { workspaceId: otherWorkspaceId });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "Access denied" }],
        structuredContent: { error: { code: "FORBIDDEN", message: "Access denied" } },
      },
    });
  });

  it("denies access after membership revocation", async () => {
    const server = createMcpServer(
      createDependencies({ membership: membership(ownerId, workspaceId, "revoked") }),
    );

    const response = await callTool(server, "get_workspace", { workspaceId });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "Access denied" }],
        structuredContent: { error: { code: "FORBIDDEN", message: "Access denied" } },
      },
    });
  });

  it("creates an invitation once and returns its audit identifier without exposing stored secrets", async () => {
    const dependencies = createDependencies();
    const server = createMcpServer(dependencies);

    const response = await callTool(server, "create_invitation", {
      workspaceId,
      email: "Friend@Example.COM",
      role: "operator",
      expiresAt: "2026-09-28T12:00:00.000Z",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              invitation: {
                id: "invitation-1",
                workspaceId,
                email: "friend@example.com",
                role: "operator",
                expiresAt: "2026-09-28T12:00:00.000Z",
              },
              token: "new-invitation-token",
              auditId: "audit-event-1",
            }),
          },
        ],
        structuredContent: {
          invitation: {
            id: "invitation-1",
            workspaceId,
            email: "friend@example.com",
            role: "operator",
            expiresAt: "2026-09-28T12:00:00.000Z",
          },
          token: "new-invitation-token",
          auditId: "audit-event-1",
        },
      },
    });
    expect(dependencies.storedInvitations).toEqual([
      expect.objectContaining({ tokenHash: "stored-hash:new-invitation-token" }),
    ]);
    expect(dependencies.storedAuditEvents).toEqual([
      { id: "audit-event-1", invitationId: "invitation-1" },
    ]);
    expect(response).not.toMatchObject({ result: { auditId: "invitation-1" } });
    expect(JSON.stringify(response)).not.toContain("stored-hash:");
    expect(JSON.stringify(response)).not.toContain("tokenHash");
  });

  it("returns a safe internal error when trusted authentication throws", async () => {
    const dependencies = createDependencies();
    const server = createMcpServer({
      ...dependencies,
      authenticate: async () => {
        throw new Error("Session provider unavailable");
      },
    });

    const response = await callTool(server, "get_workspace", { workspaceId });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        structuredContent: {
          error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("Session provider unavailable");
  });

  it("treats omitted tool arguments as an empty object and returns a tool validation error", async () => {
    const server = createMcpServer(createDependencies());

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_workspace" },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
      },
    });
  });

  it("requires trusted authentication instead of accepting actor identifiers in tool arguments", async () => {
    const server = createMcpServer(
      createDependencies({ authenticatedUserId: null, membership: membership(otherUserId) }),
    );

    const response = await callTool(server, "create_invitation", {
      workspaceId,
      actorId: ownerId,
      email: "friend@example.com",
      role: "operator",
      expiresAt: "2026-09-28T12:00:00.000Z",
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        structuredContent: {
          error: { code: "UNAUTHENTICATED", message: "Authentication required" },
        },
      },
    });
  });
});
