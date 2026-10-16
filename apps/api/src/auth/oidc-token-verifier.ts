import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { VerifiedExternalIdentity } from "@money-maker/core/identity/authentication-repository";

export const oauthScopes = [
  "workspace:read",
  "workspace:write",
  "content:read",
  "content:write",
  "content:approve",
  "publish:write",
  "connections:read",
] as const;

export type OAuthScope = (typeof oauthScopes)[number];

const oauthScopeSet = new Set<OAuthScope>(oauthScopes);

export const requireScopes = (
  context: Readonly<{ scopes?: ReadonlySet<OAuthScope> }>,
  required: readonly OAuthScope[],
): boolean => required.every((scope) => context.scopes?.has(scope) === true);

const parseScopes = (scopeClaim: unknown, permissionsClaim: unknown): ReadonlySet<OAuthScope> => {
  const scopes = [
    ...(typeof scopeClaim === "string" ? scopeClaim.split(/\s+/) : []),
    ...(Array.isArray(permissionsClaim)
      ? permissionsClaim.filter((scope): scope is string => typeof scope === "string")
      : []),
  ];
  return new Set(
    scopes.filter((scope): scope is OAuthScope => oauthScopeSet.has(scope as OAuthScope)),
  );
};

export type OidcTokenVerifier = Readonly<{
  verifyBearer(token: string): Promise<
    Readonly<{
      issuer: string;
      subject: string;
      verifiedEmail?: string;
      scopes?: ReadonlySet<OAuthScope>;
    }>
  >;
  resolveBearerEmail?(token: string, subject: string): Promise<string | undefined>;
  verifyCallback(token: string): Promise<VerifiedExternalIdentity>;
}>;

type OidcTokenVerifierOptions = Readonly<{
  issuer: string;
  bearerAudience: string;
  callbackAudience: string;
  jwks: JWTVerifyGetKey;
  userinfo?: (token: string) => Promise<unknown>;
}>;

const invalidAuthentication = (cause?: unknown): Error =>
  new Error("authentication_invalid", cause === undefined ? undefined : { cause });

const verifiedEmailFromClaims = (
  claims: unknown,
  subject: string,
  requireSubject: boolean,
): string | undefined => {
  if (typeof claims !== "object" || claims === null) return undefined;
  const values = claims as Record<string, unknown>;
  if (requireSubject && values.sub !== subject) throw invalidAuthentication();
  return values.email_verified === true && typeof values.email === "string"
    ? values.email
    : undefined;
};

export const createOidcTokenVerifier = (options: OidcTokenVerifierOptions): OidcTokenVerifier => {
  const verify = async (token: string, audience: string) => {
    try {
      const result = await jwtVerify(token, options.jwks, {
        issuer: options.issuer,
        audience,
        algorithms: ["RS256"],
      });
      const subject = result.payload.sub;
      if (!subject || result.payload.iss !== options.issuer) throw invalidAuthentication();
      return result.payload;
    } catch (error) {
      throw invalidAuthentication(error);
    }
  };

  return {
    verifyBearer: async (token) => {
      const payload = await verify(token, options.bearerAudience);
      const verifiedEmail = verifiedEmailFromClaims(payload, payload.sub as string, false);
      return {
        issuer: options.issuer,
        subject: payload.sub as string,
        scopes: parseScopes(payload.scope, payload.permissions),
        ...(verifiedEmail ? { verifiedEmail } : {}),
      };
    },
    resolveBearerEmail: async (token, subject) => {
      if (!options.userinfo) return undefined;
      try {
        return verifiedEmailFromClaims(await options.userinfo(token), subject, true);
      } catch {
        throw invalidAuthentication();
      }
    },
    verifyCallback: async (token) => {
      const payload = await verify(token, options.callbackAudience);
      if (typeof payload.email !== "string" || payload.email_verified !== true) {
        throw invalidAuthentication();
      }
      return {
        issuer: options.issuer,
        subject: payload.sub as string,
        verifiedEmail: payload.email,
      };
    },
  };
};
