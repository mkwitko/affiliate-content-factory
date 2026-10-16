import type { FastifyRequest } from "fastify";
import type { AuthenticationRepository } from "@money-maker/core/identity/authentication-repository";
import type { OidcTokenVerifier } from "./oidc-token-verifier.js";
import { oauthScopes } from "./oidc-token-verifier.js";
import { AUTH_SESSION_COOKIE, parseCookie } from "./session-cookie.js";

type AuthenticateRequestDependencies = Readonly<{
  authentication: AuthenticationRepository;
  tokenVerifier: OidcTokenVerifier;
}>;

// Safe diagnostics only: jose error code and failed claim name, never token content.
const rejectionDetails = (error: unknown): Record<string, unknown> => {
  const cause = error instanceof Error ? error.cause : undefined;
  const details = (cause ?? error) as { code?: unknown; claim?: unknown; reason?: unknown };
  return {
    error: error instanceof Error ? error.message : "unknown",
    ...(typeof details.code === "string" ? { code: details.code } : {}),
    ...(typeof details.claim === "string" ? { claim: details.claim } : {}),
    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
  };
};

const bearerToken = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
};

export const createAuthenticateRequest =
  ({ authentication, tokenVerifier }: AuthenticateRequestDependencies) =>
  async (request?: FastifyRequest) => {
    if (!request) return null;

    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const token = bearerToken(authorization);
      if (!token) {
        request.log?.warn({ reason: "malformed_authorization_header" }, "bearer rejected");
        return null;
      }
      try {
        const identity = await tokenVerifier.verifyBearer(token);
        const user = await authentication.resolveLinkedUser(identity);
        if (user) return { ...user, ...(identity.scopes ? { scopes: identity.scopes } : {}) };
        const verifiedEmail =
          identity.verifiedEmail ??
          (await tokenVerifier.resolveBearerEmail?.(token, identity.subject));
        if (!verifiedEmail) {
          request.log?.warn({ reason: "no_verified_email" }, "bearer rejected");
          return null;
        }
        if (!(await authentication.isPreAuthorizedEmail(verifiedEmail))) {
          request.log?.warn({ reason: "email_not_pre_authorized" }, "bearer rejected");
          return null;
        }
        const provisioned = await authentication.resolveOrCreateUser({
          issuer: identity.issuer,
          subject: identity.subject,
          verifiedEmail,
        });
        return { ...provisioned, ...(identity.scopes ? { scopes: identity.scopes } : {}) };
      } catch (error) {
        request.log?.warn(rejectionDetails(error), "bearer rejected");
        return null;
      }
    }

    const sessionToken = parseCookie(request.headers.cookie, AUTH_SESSION_COOKIE);
    if (!sessionToken) return null;
    try {
      const user = await authentication.resolveSession({ token: sessionToken, now: new Date() });
      return user ? { ...user, scopes: new Set(oauthScopes) } : null;
    } catch {
      return null;
    }
  };
