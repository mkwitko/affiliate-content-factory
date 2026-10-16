import { parseUserId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { AuthenticationRepository } from "@money-maker/core/identity/authentication-repository";
import { buildApp, type ApiDependencies } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const createDependencies = (overrides: Partial<AuthenticationRepository> = {}): ApiDependencies => {
  let currentSession: string | undefined;
  const authentication: AuthenticationRepository = {
    isPreAuthorizedEmail: async () => false,
    resolveOrCreateUser: async () => ({ userId, verifiedEmail: "owner@example.com" }),
    resolveLinkedUser: async () => ({ userId, verifiedEmail: "owner@example.com" }),
    createSession: async ({ token }) => {
      currentSession = token;
    },
    resolveSession: async ({ token }) =>
      token === currentSession ? { userId, verifiedEmail: "owner@example.com" } : null,
    revokeSession: async ({ token }) => {
      if (token === currentSession) currentSession = undefined;
    },
    ...overrides,
  };

  return {
    invitation: {} as ApiDependencies["invitation"],
    workspaces: {} as ApiDependencies["workspaces"],
    authenticate: async () => null,
    auth: {
      authentication,
      oidcClient: {
        authorizationUrl: async ({ state }) =>
          `https://issuer.example/authorize?state=${encodeURIComponent(state)}`,
        exchangeCode: async () => ({ idToken: "raw-id-token" }),
      },
      tokenVerifier: {
        verifyBearer: async () => ({ issuer: "https://issuer.example", subject: "subject-1" }),
        verifyCallback: async () => ({
          issuer: "https://issuer.example",
          subject: "subject-1",
          verifiedEmail: "owner@example.com",
        }),
      },
      webAppUrl: "https://web.example",
      redirectUri: "https://api.example/v1/auth/callback",
      sessionSecret: new TextEncoder().encode("12345678901234567890123456789012"),
      secureCookies: false,
    },
  };
};

describe("authentication routes", () => {
  it("rejects a callback with a wrong authorization state", async () => {
    const app = buildApp(createDependencies());
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const transactionCookie = login.headers["set-cookie"];
    const callback = await app.inject({
      method: "GET",
      url: "/v1/auth/callback?code=code-1&state=wrong-state",
      headers: { cookie: transactionCookie },
    });

    expect(login.statusCode).toBe(302);
    expect(callback.statusCode).toBe(401);
    await app.close();
  });

  it("exchanges a callback for an opaque application session", async () => {
    let createdToken = "";
    const app = buildApp(
      createDependencies({
        createSession: async ({ token }) => {
          createdToken = token;
        },
      }),
    );
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const state = new URL(login.headers.location as string).searchParams.get("state");
    const transactionCookie = login.headers["set-cookie"];
    const callback = await app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=code-1&state=${encodeURIComponent(state ?? "")}`,
      headers: { cookie: transactionCookie },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("https://web.example");
    expect(callback.headers["set-cookie"]).not.toContain(createdToken);
    expect(createdToken).not.toBe("code-1");
    await app.close();
  });

  it("requires the configured origin for cookie-authenticated logout", async () => {
    const app = buildApp(createDependencies());
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { origin: "https://evil.example", cookie: "mm_session=opaque" },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
