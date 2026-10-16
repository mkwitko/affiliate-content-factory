import { describe, expect, it, vi } from "vitest";
import {
  canvaAuthorizationUrl,
  exchangeCanvaAuthorizationCode,
  fetchCanvaAccountId,
  generateCanvaPkce,
  refreshCanvaAccessToken,
} from "./oauth-client.js";

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Canva OAuth client", () => {
  it("exchanges an authorization code for tokens using Basic auth and the PKCE verifier", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      okResponse({ access_token: "token-1", refresh_token: "refresh-1", expires_in: 3600 }),
    );

    const tokens = await exchangeCanvaAuthorizationCode({
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      redirectUri: "https://mcp.example.com/v1/integrations/canva/callback",
      codeVerifier: "verifier-1",
      fetcher,
    });

    expect(tokens).toEqual({ accessToken: "token-1", refreshToken: "refresh-1", expiresIn: 3600 });
    const [, init] = fetcher.mock.calls[0] ?? [];
    const request = init as RequestInit;
    expect((request.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
    );
    expect(String(request.body)).toContain("code_verifier=verifier-1");
    expect(String(request.body)).not.toContain("client_secret");
  });

  it("rotates the refresh token on refresh", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      okResponse({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 3600 }),
    );
    const tokens = await refreshCanvaAccessToken({
      clientId: "client-1",
      clientSecret: "secret-1",
      refreshToken: "refresh-1",
      fetcher,
    });
    expect(tokens.refreshToken).toBe("refresh-2");
  });

  it("rejects a token response missing required fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okResponse({ access_token: "only-this" }));
    await expect(
      exchangeCanvaAuthorizationCode({
        clientId: "client-1",
        clientSecret: "secret-1",
        code: "code-1",
        redirectUri: "https://example.test/callback",
        codeVerifier: "verifier-1",
        fetcher,
      }),
    ).rejects.toThrow("canva_token_response_invalid");
  });

  it("builds the Canva authorization URL with PKCE parameters and never the code_verifier", () => {
    const url = canvaAuthorizationUrl({
      clientId: "client-1",
      redirectUri: "https://mcp.example.com/v1/integrations/canva/callback",
      state: "nonce-1",
      codeChallenge: "challenge-1",
      scope: "design:content:read design:meta:read",
    });
    expect(url).toContain("https://www.canva.com/api/oauth/authorize?");
    expect(url).toContain("code_challenge=challenge-1");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=nonce-1");
    expect(url).not.toContain("verifier");
  });

  it("generates a PKCE pair whose challenge is the SHA-256 of the verifier", () => {
    const { codeVerifier, codeChallenge } = generateCanvaPkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(codeChallenge).not.toBe(codeVerifier);
  });

  it("reads the account id from users/me", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      okResponse({ team_user: { user_id: "user-1", team_id: "team-1" } }),
    );
    await expect(fetchCanvaAccountId({ accessToken: "token-1", fetcher })).resolves.toBe("user-1");
  });
});
