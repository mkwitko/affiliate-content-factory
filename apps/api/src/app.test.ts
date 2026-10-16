import { describe, expect, it } from "vitest";
import {
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId,
} from "@money-maker/contracts";
import type {
  InvitationDependencies,
  InvitationRecord,
  InvitationRole,
} from "@money-maker/core/identity/invitation-repository";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { AuthenticationRepository } from "@money-maker/core/identity/authentication-repository";
import { createAuthenticateRequest } from "./auth/authenticate-request.js";
import type { OidcTokenVerifier } from "./auth/oidc-token-verifier.js";
import { buildApp, type ApiDependencies } from "./app.js";
import { oauthScopes } from "./auth/oidc-token-verifier.js";

const ownerId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const operatorId = parseUserId("3158b518-4968-4777-80dd-1c61854d3a46");
const otherUserId = parseUserId("84d55b67-e059-4942-8191-b42a693a3525");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");
const now = new Date("2026-09-21T12:00:00.000Z");

const membership = (
  userId: UserId,
  targetWorkspaceId: WorkspaceId = workspaceId,
): WorkspaceMembership => ({
  userId,
  workspaceId: targetWorkspaceId,
  role: "owner",
  status: "active",
});

const createDependencies = (
  overrides: Partial<InvitationDependencies> = {},
  authenticatedUserId: UserId | null = ownerId,
  authenticatedEmail = authenticatedUserId === operatorId
    ? "friend@example.com"
    : "owner@example.com",
): ApiDependencies => {
  const invitations = new Map<string, InvitationRecord>();
  const defaultMemberships = {
    findByUserAndWorkspace: async ({
      userId,
      workspaceId: targetWorkspaceId,
    }: {
      userId: UserId;
      workspaceId: WorkspaceId;
    }) =>
      userId === ownerId && targetWorkspaceId === workspaceId
        ? membership(userId, targetWorkspaceId)
        : null,
    ensureMembership: async () => "created" as const,
  };
  const defaultInvitationRepository = {
    create: async (
      input: Parameters<InvitationDependencies["invitations"]["create"]>[0],
      auditEvent: Parameters<InvitationDependencies["invitations"]["create"]>[1],
    ) => {
      const record: InvitationRecord = { id: "invitation-1", status: "pending", ...input };
      await dependencies.audit.record({ ...auditEvent, invitationId: record.id });
      invitations.set(input.tokenHash, record);
      return { invitation: record, auditId: "audit-event-1" };
    },
    findByTokenHash: async ({ tokenHash }: { tokenHash: string }) =>
      invitations.get(tokenHash) ?? null,
    acceptPending: async ({
      invitationId,
      acceptedAt,
      userId,
      auditEvent,
      ensureMembership,
    }: Parameters<InvitationDependencies["invitations"]["acceptPending"]>[0]) => {
      for (const [hash, record] of invitations) {
        if (record.id === invitationId) {
          await ensureMembership();
          await dependencies.audit.record(auditEvent);
          invitations.set(hash, { ...record, status: "accepted", acceptedAt, acceptedBy: userId });
          return "accepted" as const;
        }
      }
      return "already_accepted" as const;
    },
  };
  const dependencies: InvitationDependencies = {
    memberships: defaultMemberships,
    invitations: defaultInvitationRepository,
    audit: { record: async () => "audit-event-1" },
    clock: { now: () => now },
    tokens: { generate: () => "raw-token" },
    tokenHasher: { hash: async (token) => `hash:${token}` },
    ...overrides,
  };
  return {
    invitation: dependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace Alpha" }),
      findByIdForMember: async ({ workspaceId: targetWorkspaceId, userId }) =>
        targetWorkspaceId === workspaceId && userId === ownerId
          ? { id: workspaceId, name: "Workspace Alpha" }
          : null,
      findMembership: async ({ workspaceId: targetWorkspaceId, userId }) =>
        targetWorkspaceId === workspaceId && userId === ownerId
          ? { workspaceId, userId, role: "owner", status: "active" }
          : null,
      addMembership: async () => undefined,
    } satisfies WorkspaceRepository,
    authenticate: async () =>
      authenticatedUserId
        ? {
            userId: authenticatedUserId,
            verifiedEmail: authenticatedEmail,
            scopes: new Set(oauthScopes),
          }
        : null,
  };
};

describe("HTTP API boundary", () => {
  it("awaits resource cleanup when the application closes", async () => {
    let closed = false;
    const app = buildApp({
      ...createDependencies(),
      close: async () => {
        await Promise.resolve();
        closed = true;
      },
    });
    await app.ready();
    await app.close();
    expect(closed).toBe(true);
  });

  it("keeps health available when authentication denies requests", async () => {
    const app = buildApp({
      invitation: createDependencies().invitation,
      workspaces: createDependencies().workspaces,
      authenticate: async () => null,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const invitation = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": ownerId },
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });
    expect(invitation.statusCode).toBe(401);
    expect(invitation.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });

    await app.close();
  });

  it("returns a healthy status", async () => {
    const app = buildApp(createDependencies());
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: expect.stringMatching(/^1\.0\.0\+/) });
    await app.close();
  });

  it("rejects malformed invitation input without invoking the use case", async () => {
    let called = false;
    const dependencies = createDependencies({
      memberships: {
        findByUserAndWorkspace: async () => {
          called = true;
          return membership(ownerId);
        },
        ensureMembership: async () => "created",
      },
    });
    const app = buildApp(dependencies);
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": ownerId },
      payload: { email: "not-an-email", role: "owner", expiresAt: "not-a-date" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Request validation failed" },
    });
    expect(called).toBe(false);
    await app.close();
  });

  it("rejects an unauthenticated invitation request", async () => {
    const app = buildApp(createDependencies({}, null));
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    await app.close();
  });

  it("rejects a forged user header and uses only the injected authentication context", async () => {
    const rejectedApp = buildApp(createDependencies({}, null));
    const forgedResponse = await rejectedApp.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": ownerId },
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(forgedResponse.statusCode).toBe(401);
    await rejectedApp.close();

    const trustedApp = buildApp(createDependencies({}, ownerId));
    const ignoredHeaderResponse = await trustedApp.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": otherUserId },
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(ignoredHeaderResponse.statusCode).toBe(201);
    await trustedApp.close();
  });

  it("does not disclose another workspace to an authenticated user", async () => {
    const app = buildApp(createDependencies());
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${otherWorkspaceId}/invitations`,
      headers: { "x-user-id": ownerId },
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "FORBIDDEN", message: "Access denied" } });
    await app.close();
  });

  it("creates an invitation and returns the one-time token only on success", async () => {
    const app = buildApp(createDependencies());
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": ownerId },
      payload: {
        email: "Friend@Example.COM",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      invitation: { id: "invitation-1", email: "friend@example.com", role: "operator" },
      token: "raw-token",
    });
    await app.close();
  });

  it("maps expired acceptance to a safe response without exposing the token or stack", async () => {
    const invitation: InvitationRecord = {
      id: "expired-1",
      workspaceId,
      email: "friend@example.com",
      role: "operator" as InvitationRole,
      tokenHash: "hash:expired-token",
      status: "pending",
      expiresAt: new Date("2026-09-20T12:00:00.000Z"),
      invitedBy: ownerId,
    };
    const app = buildApp(
      createDependencies(
        {
          invitations: {
            create: async () => ({ invitation, auditId: "audit-event-1" }),
            findByTokenHash: async () => invitation,
            acceptPending: async () => "accepted",
          },
        },
        operatorId,
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/invitations/expired-token/accept",
      headers: { "x-user-id": operatorId },
      payload: { email: "friend@example.com" },
    });

    expect(response.statusCode).toBe(410);
    const body = response.body;
    expect(response.json()).toEqual({
      error: { code: "INVITATION_EXPIRED", message: "Invitation has expired" },
    });
    expect(body).not.toContain("expired-token");
    expect(body).not.toContain("stack");
    await app.close();
  });

  it("binds invitation acceptance to the verified authentication email", async () => {
    const invitation: InvitationRecord = {
      id: "identity-bound-1",
      workspaceId,
      email: "friend@example.com",
      role: "operator" as InvitationRole,
      tokenHash: "hash:identity-token",
      status: "pending",
      expiresAt: new Date("2026-09-28T12:00:00.000Z"),
      invitedBy: ownerId,
    };
    const app = buildApp(
      createDependencies(
        {
          invitations: {
            create: async () => ({ invitation, auditId: "audit-event-1" }),
            findByTokenHash: async () => invitation,
            acceptPending: async () => "accepted",
          },
        },
        otherUserId,
        "other@example.com",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/invitations/identity-token/accept",
      headers: { "x-user-id": ownerId },
      payload: { email: "friend@example.com" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "INVITATION_EMAIL_MISMATCH", message: "Invitation email does not match" },
    });
    await app.close();
  });

  it("rejects invalid actor identifiers without leaking parser details", async () => {
    const app = buildApp(createDependencies({}, null));
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { "x-user-id": "not-a-uuid" },
      payload: {
        email: "friend@example.com",
        role: "operator",
        expiresAt: "2026-09-28T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    await app.close();
  });

  it("serves the authenticated MCP subset over HTTP", async () => {
    const app = buildApp(createDependencies());

    const initialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: "initialize-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json()).toMatchObject({
      jsonrpc: "2.0",
      id: "initialize-1",
      result: {
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "money-maker", version: expect.stringMatching(/^1\.0\.0\+/) },
        instructions: expect.stringContaining("Never publish a draft"),
      },
    });

    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "x-user-id": otherUserId,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_workspace", arguments: { workspaceId } },
      },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
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
    await app.close();
  });

  it("returns JSON-RPC errors and fails closed for unauthenticated MCP requests", async () => {
    const app = buildApp({
      ...createDependencies({}, null),
      workspaces: createDependencies().workspaces,
      publicApiUrl: "https://api.example.com",
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-user-id": ownerId },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain(
      'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(response.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });

  it.each(["", "not json"])(
    "challenges unauthenticated MCP requests before parsing the body %j",
    async (payload) => {
      const app = buildApp({
        ...createDependencies({}, null),
        publicApiUrl: "https://api.example.com",
      });

      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
      await app.close();
    },
  );

  it("keeps the client error status for malformed authenticated MCP requests", async () => {
    const app = buildApp(createDependencies());

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-user-id": ownerId, "content-type": "application/json" },
      payload: "not json",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it.each(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"])(
    "publishes OAuth protected resource metadata for the MCP endpoint at %s",
    async (url) => {
      const app = buildApp({
        ...createDependencies(),
        publicApiUrl: "https://api.example.com",
      });

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        resource: "https://api.example.com/mcp",
        authorization_servers: [],
        scopes_supported: oauthScopes,
      });
      await app.close();
    },
  );

  it("uses the same trusted bearer identity for MCP authorization", async () => {
    const authentication: AuthenticationRepository = {
      isPreAuthorizedEmail: async () => false,
      resolveOrCreateUser: async () => ({ userId: ownerId, verifiedEmail: "owner@example.com" }),
      resolveLinkedUser: async ({ subject }) =>
        subject === "owner-subject"
          ? { userId: ownerId, verifiedEmail: "owner@example.com" }
          : null,
      createSession: async () => undefined,
      resolveSession: async () => null,
      revokeSession: async () => undefined,
    };
    const tokenVerifier: OidcTokenVerifier = {
      verifyBearer: async () => ({
        issuer: "https://issuer.example",
        subject: "owner-subject",
        scopes: new Set(oauthScopes),
      }),
      verifyCallback: async () => ({
        issuer: "https://issuer.example",
        subject: "owner-subject",
        verifiedEmail: "owner@example.com",
      }),
    };
    const app = buildApp({
      ...createDependencies({}, null),
      authenticate: createAuthenticateRequest({ authentication, tokenVerifier }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer signed-token",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_workspace", arguments: { workspaceId } },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent).toEqual({
      workspace: { id: workspaceId, name: "Workspace Alpha" },
    });
    await app.close();
  });

  it("returns standard JSON-RPC errors for invalid MCP requests and methods", async () => {
    const app = buildApp(createDependencies());

    const invalidRequest = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "unknown/method" },
    });
    expect(invalidRequest.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });

    const invalidParams = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} },
    });
    expect(invalidParams.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: expect.stringContaining('"name"') },
    });

    const malformed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: {},
    });
    expect(malformed.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
    });
    await app.close();
  });
});
