import { describe, expect, it, vi } from "vitest";
import {
  exchangeMercadoLivreAuthorizationCode,
  refreshMercadoLivreAccessToken,
  mercadoLivreAuthorizationUrl,
} from "./oauth-client.js";

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Mercado Livre OAuth client", () => {
  it("exchanges an authorization code for tokens", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      okResponse({
        access_token: "APP_USR-token",
        refresh_token: "TG-refresh-1",
        expires_in: 21600,
        user_id: 123456,
      }),
    );

    const tokens = await exchangeMercadoLivreAuthorizationCode({
      appId: "app-1",
      appSecret: "secret-1",
      code: "code-1",
      redirectUri: "https://mcp.example.com/v1/integrations/mercado-livre/callback",
      fetcher,
    });

    expect(tokens).toEqual({
      accessToken: "APP_USR-token",
      refreshToken: "TG-refresh-1",
      expiresIn: 21600,
      userId: "123456",
    });
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(String((init as RequestInit).body)).toContain("grant_type=authorization_code");
  });

  it("rotates the refresh token on refresh", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      okResponse({
        access_token: "APP_USR-token-2",
        refresh_token: "TG-refresh-2",
        expires_in: 21600,
        user_id: 123456,
      }),
    );

    const tokens = await refreshMercadoLivreAccessToken({
      appId: "app-1",
      appSecret: "secret-1",
      refreshToken: "TG-refresh-1",
      fetcher,
    });

    expect(tokens.refreshToken).toBe("TG-refresh-2");
    expect(tokens.refreshToken).not.toBe("TG-refresh-1");
  });

  it("rejects a token response missing required fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okResponse({ access_token: "only-this" }));
    await expect(
      exchangeMercadoLivreAuthorizationCode({
        appId: "app-1",
        appSecret: "secret-1",
        code: "code-1",
        redirectUri: "https://example.test/callback",
        fetcher,
      }),
    ).rejects.toThrow("mercado_livre_token_response_invalid");
  });

  it("builds the Mercado Livre authorization URL", () => {
    const url = mercadoLivreAuthorizationUrl({
      appId: "app-1",
      redirectUri: "https://mcp.example.com/v1/integrations/mercado-livre/callback",
      state: "sealed-state",
    });
    expect(url).toBe(
      "https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=app-1&redirect_uri=https%3A%2F%2Fmcp.example.com%2Fv1%2Fintegrations%2Fmercado-livre%2Fcallback&state=sealed-state",
    );
  });
});
