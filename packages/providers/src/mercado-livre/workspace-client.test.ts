import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import { createMercadoLivreClientForWorkspace } from "./workspace-client.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "mercado_livre",
  mode: "oauth",
  accountId: "123456",
  status: "active",
  secretReference: `secret://workspace/${workspaceId}/mercado-livre/tokens/connection-1`,
};

const memorySecretStore = (
  initial: string,
): { store: SecretStore; values: Map<string, string> } => {
  const values = new Map([[connection.secretReference, initial]]);
  return {
    values,
    store: {
      put: async ({ reference, secret }) => void values.set(reference, secret),
      get: async (reference) => values.get(reference) ?? null,
      delete: async (reference) => void values.delete(reference),
    },
  };
};

describe("Mercado Livre workspace client", () => {
  it("throws a clear error when no tokens are stored", async () => {
    const { store } = memorySecretStore("");
    const client = createMercadoLivreClientForWorkspace({
      secretStore: { ...store, get: async () => null },
      connection,
      appId: "app-1",
      appSecret: "secret-1",
    });
    await expect(client.request("/sites/MLB/search?q=x")).rejects.toThrow(
      "mercado_livre_not_connected",
    );
  });

  it("uses the stored access token without refreshing while it is still fresh", async () => {
    const { store } = memorySecretStore(
      JSON.stringify({
        accessToken: "fresh-token",
        refreshToken: "TG-refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const client = createMercadoLivreClientForWorkspace({
      secretStore: store,
      connection,
      appId: "app-1",
      appSecret: "secret-1",
      fetcher,
    });

    await client.request("/sites/MLB/search?q=x");

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer fresh-token" });
  });

  it("refreshes an expiring token, persists the rotated refresh token, and a later refresh uses only the new one", async () => {
    const { store, values } = memorySecretStore(
      JSON.stringify({
        accessToken: "stale-token",
        refreshToken: "TG-refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String((init as RequestInit).body ?? "");
      if (body.includes("refresh_token=TG-refresh-1")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token",
            refresh_token: "TG-refresh-2",
            expires_in: 21600,
            user_id: 123456,
          }),
          { status: 200 },
        );
      }
      // A refresh must never be attempted with the stale TG-refresh-1 token again:
      // only TG-refresh-2 (the rotated value) may successfully exchange here.
      if (body.includes("refresh_token=TG-refresh-2")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token-2",
            refresh_token: "TG-refresh-3",
            expires_in: 21600,
            user_id: 123456,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const client = createMercadoLivreClientForWorkspace({
      secretStore: store,
      connection,
      appId: "app-1",
      appSecret: "secret-1",
      fetcher,
    });

    await client.request("/sites/MLB/search?q=x");

    const stored = JSON.parse(values.get(connection.secretReference) ?? "{}") as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("refreshed-token");
    expect(stored.refreshToken).toBe("TG-refresh-2");

    // A second refresh must only succeed using the rotated token, never the stale one.
    fetcher.mockClear();
    values.set(
      connection.secretReference,
      JSON.stringify({
        accessToken: "refreshed-token",
        refreshToken: "TG-refresh-2",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );
    await client.request("/sites/MLB/search?q=x");
    const [, secondInit] = fetcher.mock.calls[0] ?? [];
    expect(String((secondInit as RequestInit).body)).toContain("TG-refresh-2");
  });

  it.each([400, 401])(
    "surfaces a %i refresh failure as mercado_livre_not_connected",
    async (status) => {
      const { store } = memorySecretStore(
        JSON.stringify({
          accessToken: "stale-token",
          refreshToken: "TG-refresh-1",
          accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        }),
      );
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status }),
      );
      const client = createMercadoLivreClientForWorkspace({
        secretStore: store,
        connection,
        appId: "app-1",
        appSecret: "secret-1",
        fetcher,
      });

      await expect(client.request("/sites/MLB/search?q=x")).rejects.toThrow(
        "mercado_livre_not_connected",
      );
    },
  );

  it("resolves concurrent refreshes to a single token request", async () => {
    const { store, values } = memorySecretStore(
      JSON.stringify({
        accessToken: "stale-token",
        refreshToken: "TG-refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );
    let refreshCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String((init as RequestInit).body ?? "");
      if (body.includes("grant_type=refresh_token")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token",
            refresh_token: "TG-refresh-2",
            expires_in: 21600,
            user_id: 123456,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const client = createMercadoLivreClientForWorkspace({
      secretStore: store,
      connection,
      appId: "app-1",
      appSecret: "secret-1",
      fetcher,
    });

    await Promise.all([
      client.request("/sites/MLB/search?q=a"),
      client.request("/sites/MLB/search?q=b"),
    ]);

    expect(refreshCalls).toBe(1);
    const stored = JSON.parse(values.get(connection.secretReference) ?? "{}") as {
      accessToken: string;
    };
    expect(stored.accessToken).toBe("refreshed-token");
  });
});
