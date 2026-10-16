import { parseUserId } from "@money-maker/contracts";
import type { AuthenticationRepository } from "@money-maker/core/identity/authentication-repository";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticateRequest } from "./authenticate-request.js";
import { oauthScopes } from "./oidc-token-verifier.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const createRequest = (headers: Record<string, string>) => ({ headers }) as never;

const createRepository = (): AuthenticationRepository => ({
  isPreAuthorizedEmail: async () => false,
  resolveOrCreateUser: async () => ({ userId, verifiedEmail: "owner@example.com" }),
  resolveLinkedUser: async ({ subject }) =>
    subject === "linked-subject" ? { userId, verifiedEmail: "owner@example.com" } : null,
  createSession: async () => undefined,
  resolveSession: async ({ token }) =>
    token === "browser-session" ? { userId, verifiedEmail: "owner@example.com" } : null,
  revokeSession: async () => undefined,
});

describe("createAuthenticateRequest", () => {
  it("authenticates an opaque browser session", async () => {
    const authenticate = createAuthenticateRequest({
      authentication: createRepository(),
      tokenVerifier: {
        verifyBearer: vi.fn(),
        verifyCallback: vi.fn(),
      },
    });

    await expect(
      authenticate(createRequest({ cookie: "mm_session=browser-session" })),
    ).resolves.toEqual({
      userId,
      verifiedEmail: "owner@example.com",
      scopes: new Set(oauthScopes),
    });
  });

  it("resolves bearer identities only when they are already linked", async () => {
    const authenticate = createAuthenticateRequest({
      authentication: createRepository(),
      tokenVerifier: {
        verifyBearer: vi.fn(async () => ({
          issuer: "https://issuer.example",
          subject: "linked-subject",
        })),
        verifyCallback: vi.fn(),
      },
    });

    await expect(
      authenticate(createRequest({ authorization: "Bearer signed-token" })),
    ).resolves.toEqual({ userId, verifiedEmail: "owner@example.com" });
  });

  it("provisions a pre-authorized bearer identity on first access", async () => {
    const resolveOrCreateUser = vi.fn(async () => ({
      userId,
      verifiedEmail: "owner@example.com",
    }));
    const authentication = {
      ...createRepository(),
      resolveOrCreateUser,
      isPreAuthorizedEmail: vi.fn(async (email: string) => email === "owner@example.com"),
    } as AuthenticationRepository;
    const resolveBearerEmail = vi.fn(async () => "owner@example.com");
    const authenticate = createAuthenticateRequest({
      authentication,
      tokenVerifier: {
        verifyBearer: vi.fn(async () => ({
          issuer: "https://issuer.example",
          subject: "new-subject",
        })),
        resolveBearerEmail,
        verifyCallback: vi.fn(),
      },
    });

    await expect(
      authenticate(createRequest({ authorization: "Bearer signed-token" })),
    ).resolves.toEqual({ userId, verifiedEmail: "owner@example.com" });
    expect(resolveOrCreateUser).toHaveBeenCalledWith({
      issuer: "https://issuer.example",
      subject: "new-subject",
      verifiedEmail: "owner@example.com",
    });
    expect(resolveBearerEmail).toHaveBeenCalledWith("signed-token", "new-subject");
  });

  it("rejects first access from a non-authorized bearer email", async () => {
    const resolveOrCreateUser = vi.fn(async () => ({
      userId,
      verifiedEmail: "other@example.com",
    }));
    const authentication = {
      ...createRepository(),
      resolveOrCreateUser,
      isPreAuthorizedEmail: vi.fn(async () => false),
    } as AuthenticationRepository;
    const authenticate = createAuthenticateRequest({
      authentication,
      tokenVerifier: {
        verifyBearer: vi.fn(async () => ({
          issuer: "https://issuer.example",
          subject: "unapproved-subject",
          verifiedEmail: "other@example.com",
        })),
        verifyCallback: vi.fn(),
      },
    });

    await expect(
      authenticate(createRequest({ authorization: "Bearer signed-token" })),
    ).resolves.toBeNull();
    expect(resolveOrCreateUser).not.toHaveBeenCalled();
  });

  it("gives a malformed bearer credential precedence over a valid session", async () => {
    const authentication = createRepository();
    const tokenVerifier = {
      verifyBearer: vi.fn(async () => {
        throw new Error("authentication_invalid");
      }),
      verifyCallback: vi.fn(),
    };
    const authenticate = createAuthenticateRequest({ authentication, tokenVerifier });

    await expect(
      authenticate(
        createRequest({
          authorization: "Bearer forged-token",
          cookie: "mm_session=browser-session",
        }),
      ),
    ).resolves.toBeNull();
    expect(tokenVerifier.verifyBearer).toHaveBeenCalledWith("forged-token");
  });

  it("fails closed when no trusted credential is present", async () => {
    const authenticate = createAuthenticateRequest({
      authentication: createRepository(),
      tokenVerifier: { verifyBearer: vi.fn(), verifyCallback: vi.fn() },
    });

    await expect(authenticate(createRequest({}))).resolves.toBeNull();
  });
});
