import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createOidcTokenVerifier, requireScopes } from "./oidc-token-verifier.js";

const issuer = "https://issuer.example";
const bearerAudience = "https://api.example/mcp";
const callbackAudience = "auth0-client-id";

describe("OIDC token verifier", () => {
  let sign: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let verifier: ReturnType<typeof createOidcTokenVerifier>;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    sign = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
    verifier = createOidcTokenVerifier({
      issuer,
      bearerAudience,
      callbackAudience,
      jwks,
    });
  });

  const token = async (claims: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: "subject-1",
      iss: issuer,
      aud: bearerAudience,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(sign);

  it("rejects a token with the wrong audience", async () => {
    const signed = await new SignJWT({ sub: "subject-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("wrong-audience")
      .setExpirationTime("5m")
      .sign(sign);

    await expect(verifier.verifyBearer(signed)).rejects.toThrow("authentication_invalid");
  });

  it("returns only issuer and subject for a valid bearer token", async () => {
    await expect(
      verifier.verifyBearer(await token({ email: "ignored@example.com" })),
    ).resolves.toEqual({
      issuer,
      subject: "subject-1",
      scopes: new Set(),
    });
  });

  it("returns a verified bearer email when the provider includes it", async () => {
    await expect(
      verifier.verifyBearer(await token({ email: "owner@example.com", email_verified: true })),
    ).resolves.toEqual({
      issuer,
      subject: "subject-1",
      scopes: new Set(),
      verifiedEmail: "owner@example.com",
    });
  });

  it("uses the OIDC UserInfo response when the access token omits email", async () => {
    const signed = await token();
    const userinfoVerifier = createOidcTokenVerifier({
      issuer,
      bearerAudience,
      callbackAudience,
      jwks,
      userinfo: async (receivedToken) => {
        expect(receivedToken).toBe(signed);
        return {
          sub: "subject-1",
          email: "owner@example.com",
          email_verified: true,
        };
      },
    });

    await expect(userinfoVerifier.resolveBearerEmail?.(signed, "subject-1")).resolves.toBe(
      "owner@example.com",
    );
  });

  it("does not require UserInfo to validate an access token", async () => {
    const userinfo = vi.fn(async () => {
      throw new Error("userinfo_unavailable");
    });
    const bearerVerifier = createOidcTokenVerifier({
      issuer,
      bearerAudience,
      callbackAudience,
      jwks,
      userinfo,
    });

    await expect(bearerVerifier.verifyBearer(await token())).resolves.toMatchObject({
      issuer,
      subject: "subject-1",
    });
    expect(userinfo).not.toHaveBeenCalled();
  });

  it("preserves accepted bearer scopes and rejects a missing publish scope", async () => {
    const context = await verifier.verifyBearer(await token({ scope: "content:read" }));

    expect(context.scopes).toEqual(new Set(["content:read"]));
    expect(requireScopes(context, ["content:read"])).toBe(true);
    expect(requireScopes(context, ["publish:write"])).toBe(false);
  });

  it("accepts Auth0 RBAC permissions when scopes are emitted as an array", async () => {
    const context = await verifier.verifyBearer(
      await token({ permissions: ["workspace:read", "publish:write", "unknown:permission"] }),
    );

    expect(context.scopes).toEqual(new Set(["workspace:read", "publish:write"]));
  });

  it("requires a verified email for callback identity linking", async () => {
    await expect(
      verifier.verifyCallback(await token({ email: "person@example.com", email_verified: false })),
    ).rejects.toThrow("authentication_invalid");
    await expect(
      verifier.verifyCallback(
        await new SignJWT({
          sub: "subject-1",
          iss: issuer,
          aud: callbackAudience,
          email: "person@example.com",
          email_verified: true,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setExpirationTime("5m")
          .sign(sign),
      ),
    ).resolves.toEqual({ issuer, subject: "subject-1", verifiedEmail: "person@example.com" });
  });

  it("rejects a bearer token when its audience is only the browser client", async () => {
    const signed = await new SignJWT({ sub: "subject-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(callbackAudience)
      .setExpirationTime("5m")
      .sign(sign);

    await expect(verifier.verifyBearer(signed)).rejects.toThrow("authentication_invalid");
  });
});
