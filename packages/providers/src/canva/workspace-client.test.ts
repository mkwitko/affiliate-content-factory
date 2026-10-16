import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import { createCanvaClientForWorkspace } from "./workspace-client.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "canva",
  mode: "oauth",
  accountId: "user-1",
  status: "active",
  secretReference: `secret://workspace/${workspaceId}/canva/tokens/connection-1`,
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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const png = async () =>
  sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();

describe("Canva workspace client", () => {
  it("throws a clear error when no tokens are stored", async () => {
    const { store } = memorySecretStore("");
    const client = createCanvaClientForWorkspace({
      secretStore: { ...store, get: async () => null },
      connection,
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    await expect(
      client.exportPages({ designId: "design-1", pages: [1], format: "png" }),
    ).rejects.toThrow("canva_not_connected");
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const { store, values } = memorySecretStore(
      JSON.stringify({
        accessToken: "stale-token",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );
    const bytes = await png();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/oauth/token") {
        expect(String((init as RequestInit).body)).toContain("refresh_token=refresh-1");
        return jsonResponse({
          access_token: "fresh-token",
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }
      if (url === "https://api.canva.com/rest/v1/exports")
        return jsonResponse({ job: { id: "job-1" } });
      if (url === "https://api.canva.com/rest/v1/exports/job-1")
        return jsonResponse({
          job: {
            id: "job-1",
            status: "success",
            urls: ["https://export-download.canva.com/p1.png"],
          },
        });
      if (url === "https://export-download.canva.com/p1.png")
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = createCanvaClientForWorkspace({
      secretStore: store,
      connection,
      clientId: "client-1",
      clientSecret: "secret-1",
      fetcher,
    });
    await client.exportPages({ designId: "design-1", pages: [1], format: "png" });

    const stored = JSON.parse(values.get(connection.secretReference) ?? "{}") as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("fresh-token");
    expect(stored.refreshToken).toBe("refresh-2");
    expect(stored.refreshToken).not.toBe("refresh-1");
  });

  it("uses the stored access token without refreshing while it is still fresh", async () => {
    const { store } = memorySecretStore(
      JSON.stringify({
        accessToken: "fresh-token",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    const bytes = await png();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/exports")
        return jsonResponse({ job: { id: "job-1" } });
      if (url === "https://api.canva.com/rest/v1/exports/job-1")
        return jsonResponse({
          job: {
            id: "job-1",
            status: "success",
            urls: ["https://export-download.canva.com/p1.png"],
          },
        });
      if (url === "https://export-download.canva.com/p1.png")
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = createCanvaClientForWorkspace({
      secretStore: store,
      connection,
      clientId: "client-1",
      clientSecret: "secret-1",
      fetcher,
    });
    await client.exportPages({ designId: "design-1", pages: [1], format: "png" });

    const exportCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/exports"));
    if (!exportCall) throw new Error("expected an /exports call");
    expect((exportCall[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer fresh-token",
    });
  });

  it.each([400, 401])("surfaces a %i refresh failure as canva_token_invalid", async (status) => {
    const { store } = memorySecretStore(
      JSON.stringify({
        accessToken: "stale-token",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status }),
    );
    const client = createCanvaClientForWorkspace({
      secretStore: store,
      connection,
      clientId: "client-1",
      clientSecret: "secret-1",
      fetcher,
    });
    await expect(
      client.exportPages({ designId: "design-1", pages: [1], format: "png" }),
    ).rejects.toThrow("canva_token_invalid");
  });
});
