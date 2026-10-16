import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  discovery,
  type Configuration,
} from "openid-client";
import { createRemoteJWKSet } from "jose";
import { createOidcTokenVerifier, type OidcTokenVerifier } from "./oidc-token-verifier.js";

export type OidcClient = Readonly<{
  authorizationUrl(
    input: Readonly<{ state: string; nonce: string; codeVerifier: string }>,
  ): Promise<string>;
  exchangeCode(
    input: Readonly<{ callbackUrl: string; state: string; nonce: string; codeVerifier: string }>,
  ): Promise<Readonly<{ idToken: string }>>;
}>;

type OidcClientOptions = Readonly<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  audience?: string;
}>;

export type OidcSecurity = Readonly<{
  oidcClient: OidcClient;
  tokenVerifier: OidcTokenVerifier;
}>;

const discoverConfiguration = async (options: OidcClientOptions): Promise<Configuration> =>
  discovery(
    new URL(options.issuer),
    options.clientId,
    { redirect_uris: [options.redirectUri], response_types: ["code"] },
    ClientSecretPost(options.clientSecret),
  );

export const createOidcClient = async (options: OidcClientOptions): Promise<OidcClient> => {
  const configuration = await discoverConfiguration(options);
  return createOidcClientFromConfiguration(configuration, options.redirectUri, options.audience);
};

export const createOidcSecurity = async (
  options: OidcClientOptions & Readonly<{ audience: string }>,
): Promise<OidcSecurity> => {
  const configuration = await discoverConfiguration(options);
  const jwksUri = configuration.serverMetadata().jwks_uri;
  if (typeof jwksUri !== "string") throw new Error("OIDC discovery did not provide jwks_uri");
  const userinfoEndpoint = configuration.serverMetadata().userinfo_endpoint;
  const userinfo =
    typeof userinfoEndpoint === "string"
      ? async (token: string): Promise<unknown> => {
          const response = await fetch(userinfoEndpoint, {
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          });
          if (!response.ok) throw new Error("authentication_invalid");
          return response.json();
        }
      : undefined;
  return {
    oidcClient: createOidcClientFromConfiguration(
      configuration,
      options.redirectUri,
      options.audience,
    ),
    tokenVerifier: createOidcTokenVerifier({
      issuer: options.issuer,
      bearerAudience: options.audience,
      callbackAudience: options.clientId,
      jwks: createRemoteJWKSet(new URL(jwksUri)),
      ...(userinfo ? { userinfo } : {}),
    }),
  };
};

export const createOidcClientFromConfiguration = (
  configuration: Configuration,
  redirectUri: string,
  audience?: string,
): OidcClient => ({
  authorizationUrl: async ({ state, nonce, codeVerifier }) => {
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    return buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      ...(audience ? { audience } : {}),
    }).toString();
  },
  exchangeCode: async ({ callbackUrl, state, nonce, codeVerifier }) => {
    const response = await authorizationCodeGrant(configuration, new URL(callbackUrl), {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    if (typeof response.id_token !== "string") throw new Error("authentication_invalid");
    return { idToken: response.id_token };
  },
});
