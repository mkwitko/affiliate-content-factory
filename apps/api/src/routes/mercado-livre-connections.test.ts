import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { MERCADO_LIVRE_STATE_COOKIE } from "../auth/session-cookie.js";
import { buildApp, type ApiDependencies } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const otherUserId = parseUserId("1997e456-6ea2-430f-8c5e-d98e39430d3e");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const sessionSecret = new TextEncoder().encode("12345678901234567890123456789012");

const createFixture = () => {
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
  // authenticate reads a test-only "x-test-user" header so a test can simulate the
  // browser's dashboard session belonging to a different user than the one who started
  // the OAuth transaction (e.g. an attacker-crafted callback link opened by another user).
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
  };
  return { dependencies, records, secrets };
};

const connectAndGetTransaction = async (
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<{ state: string; cookie: string }> => {
  const response = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}/provider-connections/mercado-livre/connect`,
  });
  const location = new URL(response.headers.location as string);
  const state = location.searchParams.get("state");
  if (!state) throw new Error("connect did not return a state");
  const rawSetCookie = response.headers["set-cookie"];
  const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
  const cookiePair = setCookie?.split(";")[0]?.trim();
  if (!cookiePair?.startsWith(`${MERCADO_LIVRE_STATE_COOKIE}=`)) {
    throw new Error("connect did not set the state cookie");
  }
  return { state, cookie: cookiePair };
};

describe("Mercado Livre connection routes", () => {
  it("stores app credentials without leaking them in the response", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/mercado-livre/credentials`,
      payload: { appId: "app-1", appSecret: "secret-1" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).not.toContain("secret-1");
    expect(fixture.secrets.size).toBe(1);
    await app.close();
  });

  it("redirects to the Mercado Livre authorization URL once credentials exist", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections/mercado-livre/connect`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location).toContain("https://auth.mercadolivre.com.br/authorization");
    expect(location).toContain("client_id=app-1");
    // The callback must return through the dashboard origin, where the session and state cookies live.
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(
      "https://money-maker-web.example/v1/integrations/mercado-livre/callback",
    );
    await app.close();
  });

  it("rejects a callback with a tampered state and creates no connection", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=not-a-real-state`,
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("exchanges the code and creates an oauth connection on a valid callback", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "APP_USR-token",
          refresh_token: "TG-refresh-1",
          expires_in: 21600,
          user_id: 123456,
        }),
        { status: 200 },
      ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({ provider: "mercado_livre", accountId: "123456" });
    fetchSpy.mockRestore();
    await app.close();
  });

  it("stores the Mercado Livre nickname as the connection display name", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/users/me")
        ? new Response(JSON.stringify({ id: 123456, nickname: "LOJA_VALEACOMPRA" }), {
            status: 200,
          })
        : new Response(
            JSON.stringify({
              access_token: "APP_USR-token",
              refresh_token: "TG-refresh-1",
              expires_in: 21600,
              user_id: 123456,
            }),
            { status: 200 },
          ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(fixture.records[0]).toMatchObject({
      accountId: "123456",
      displayName: "LOJA_VALEACOMPRA",
    });
    fetchSpy.mockRestore();
    await app.close();
  });

  it("clears the single-use state cookie after a successful callback", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "APP_USR-token",
          refresh_token: "TG-refresh-1",
          expires_in: 21600,
          user_id: 123456,
        }),
        { status: 200 },
      ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    const rawSetCookie = response.headers["set-cookie"];
    const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie.join("; ") : rawSetCookie;
    expect(setCookie).toContain(`${MERCADO_LIVRE_STATE_COOKIE}=;`);
    fetchSpy.mockRestore();
    await app.close();
  });

  it("rejects a callback when the browser session belongs to a different user (CSRF binding)", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "APP_USR-token",
          refresh_token: "TG-refresh-1",
          expires_in: 21600,
          user_id: 123456,
        }),
        { status: 200 },
      ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie, "x-test-user": "other" },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.records).toHaveLength(0);
    expect(fixture.secrets.size).toBe(1);
    fetchSpy.mockRestore();
    await app.close();
  });

  it("rejects a callback missing the single-use state cookie (state replay/CSRF)", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "APP_USR-token",
          refresh_token: "TG-refresh-1",
          expires_in: 21600,
          user_id: 123456,
        }),
        { status: 200 },
      ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.records).toHaveLength(0);
    expect(fixture.secrets.size).toBe(1);
    fetchSpy.mockRestore();
    await app.close();
  });

  it("reactivates a revoked connection when reconnecting the same Mercado Livre account", async () => {
    const fixture = createFixture();
    fixture.secrets.set(
      `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      JSON.stringify({ appId: "app-1", appSecret: "secret-1" }),
    );
    fixture.records.push({
      id: "connection-1",
      workspaceId,
      provider: "mercado_livre",
      mode: "oauth",
      accountId: "123456",
      status: "revoked",
      secretReference: `secret://workspace/${workspaceId}/mercado-livre/tokens/old`,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "APP_USR-token-2",
          refresh_token: "TG-refresh-2",
          expires_in: 21600,
          user_id: 123456,
        }),
        { status: 200 },
      ),
    );
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const { state, cookie } = await connectAndGetTransaction(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/mercado-livre/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({
      id: "connection-1",
      status: "active",
      accountId: "123456",
    });
    fetchSpy.mockRestore();
    await app.close();
  });
});
