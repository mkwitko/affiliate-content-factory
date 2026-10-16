import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { CANVA_STATE_COOKIE } from "../auth/session-cookie.js";
import { buildApp, type ApiDependencies } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const otherUserId = parseUserId("1997e456-6ea2-430f-8c5e-d98e39430d3e");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const sessionSecret = new TextEncoder().encode("12345678901234567890123456789012");

const tokenResponse = () =>
  new Response(
    JSON.stringify({ access_token: "token-1", refresh_token: "refresh-1", expires_in: 3600 }),
    { status: 200 },
  );
const usersMeResponse = () =>
  new Response(JSON.stringify({ team_user: { user_id: "user-1", team_id: "team-1" } }), {
    status: 200,
  });

const createFixture = (options: { withCanva?: boolean } = {}) => {
  const records: ProviderConnection[] = [];
  const secrets = new Map<string, string>();
  const providerConnections: ProviderConnectionRepository = {
    create: async (connection) => {
      records.push(connection);
      return { ok: true, connection };
    },
    findAllForWorkspace: async ({ workspaceId: target }) =>
      records.filter((connection) => connection.workspaceId === target),
    findForWorkspace: async ({ workspaceId: target, connectionId }) =>
      records.find((c) => c.workspaceId === target && c.id === connectionId) ?? null,
    revoke: async () => undefined,
    reactivate: async ({ workspaceId: target, connectionId, secretReference }) => {
      const index = records.findIndex((c) => c.workspaceId === target && c.id === connectionId);
      const current = records[index];
      if (!current) return null;
      const updated: ProviderConnection = { ...current, status: "active", secretReference };
      records[index] = updated;
      return updated;
    },
  };
  const secretStore: SecretStore = {
    put: async ({ reference, secret }) => void secrets.set(reference, secret),
    get: async (reference) => secrets.get(reference) ?? null,
    delete: async (reference) => void secrets.delete(reference),
  };
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async ({ workspaceId: target }) =>
      target === workspaceId ? { id: workspaceId, name: "Workspace" } : null,
    findMembership: async ({ workspaceId: target, userId: target2 }) =>
      target === workspaceId
        ? ({
            workspaceId,
            userId: target2,
            role: "owner",
            status: "active",
          } satisfies WorkspaceMembership)
        : null,
    addMembership: async () => undefined,
  };
  const dependencies: ApiDependencies = {
    invitation: {} as InvitationDependencies,
    workspaces,
    providerConnections,
    secretStore,
    secretStoreForWorkspace: () => secretStore,
    publicApiUrl: "https://mcp.example.com",
    authenticate: async (request) => {
      const header = request?.headers["x-test-user"];
      const target = header === "other" ? otherUserId : userId;
      return { userId: target, verifiedEmail: "owner@example.com" };
    },
    auth: {
      sessionSecret,
      webAppUrl: "https://money-maker-web.example/",
      secureCookies: false,
    } as NonNullable<ApiDependencies["auth"]>,
    ...(options.withCanva !== false
      ? { canva: { clientId: "client-1", clientSecret: "secret-1" } }
      : {}),
  };
  return { dependencies, records, secrets };
};

const connectAndGetTransaction = async (
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<{ state: string; cookie: string }> => {
  const response = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}/provider-connections/canva/connect`,
  });
  const location = new URL(response.headers.location as string);
  const state = location.searchParams.get("state");
  if (!state) throw new Error("connect did not return a state");
  const rawSetCookie = response.headers["set-cookie"];
  const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
  const cookiePair = setCookie?.split(";")[0]?.trim();
  if (!cookiePair?.startsWith(`${CANVA_STATE_COOKIE}=`)) {
    throw new Error("connect did not set the state cookie");
  }
  return { state, cookie: cookiePair };
};

describe("Canva connection routes", () => {
  it("redirects to the Canva authorization URL with PKCE parameters", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections/canva/connect`,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://www.canva.com/api/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-1");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("design:content:read design:meta:read");
    expect(location.searchParams.toString()).not.toContain("verifier");
    expect(new URL(location.searchParams.get("redirect_uri") ?? "").pathname).toBe(
      "/v1/integrations/canva/callback",
    );
    await app.close();
  });

  it("returns 501 when Canva credentials are not configured", async () => {
    const fixture = createFixture({ withCanva: false });
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections/canva/connect`,
    });

    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it("rejects a callback with a tampered state cookie", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=nonce-1`,
      headers: { cookie: `${CANVA_STATE_COOKIE}=not-a-real-state` },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("rejects a callback missing the single-use state cookie", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("rejects a callback whose state query parameter does not match the sealed nonce", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=not-the-real-nonce`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("rejects a callback when the browser session belongs to a different user (CSRF binding)", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie, "x-test-user": "other" },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("exchanges the code and creates an oauth connection on a valid callback", async () => {
    const fixture = createFixture();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/users/me") ? usersMeResponse() : tokenResponse(),
      );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect((response.headers.location as string).includes("canva_connected=1")).toBe(true);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({ provider: "canva", accountId: "user-1" });
    fetchSpy.mockRestore();
    await app.close();
  });

  it("clears the single-use state cookie after a successful callback", async () => {
    const fixture = createFixture();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/users/me") ? usersMeResponse() : tokenResponse(),
      );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    const rawSetCookie = response.headers["set-cookie"];
    const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie.join("; ") : rawSetCookie;
    expect(setCookie).toContain(`${CANVA_STATE_COOKIE}=;`);
    fetchSpy.mockRestore();
    await app.close();
  });

  it("reactivates a revoked connection when reconnecting the same Canva account", async () => {
    const fixture = createFixture();
    fixture.records.push({
      id: "connection-1",
      workspaceId,
      provider: "canva",
      mode: "oauth",
      accountId: "user-1",
      status: "revoked",
      secretReference: `secret://workspace/${workspaceId}/canva/tokens/old`,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/users/me") ? usersMeResponse() : tokenResponse(),
      );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/canva/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({
      id: "connection-1",
      status: "active",
      accountId: "user-1",
    });
    fetchSpy.mockRestore();
    await app.close();
  });
});
