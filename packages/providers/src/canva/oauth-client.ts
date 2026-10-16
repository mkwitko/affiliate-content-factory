import { createHash, randomBytes } from "node:crypto";

export class CanvaTokenRequestError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super("canva_token_request_failed");
    this.name = "CanvaTokenRequestError";
    this.status = status;
  }
}

export type CanvaTokenResponse = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}>;

type RawTokenResponse = Readonly<{
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}>;

const parseTokenResponse = (body: RawTokenResponse): CanvaTokenResponse => {
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("canva_token_response_invalid");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
  };
};

const requestToken = async (
  fetcher: typeof fetch,
  clientId: string,
  clientSecret: string,
  params: Record<string, string>,
): Promise<CanvaTokenResponse> => {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetcher("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new CanvaTokenRequestError(response.status);
  return parseTokenResponse((await response.json()) as RawTokenResponse);
};

export const exchangeCanvaAuthorizationCode = async (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetcher?: typeof fetch;
}): Promise<CanvaTokenResponse> =>
  requestToken(input.fetcher ?? fetch, input.clientId, input.clientSecret, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });

// Canva refresh tokens are single-use and rotate on every call; the response always carries
// a new refresh_token that callers must persist in place of the old one.
export const refreshCanvaAccessToken = async (input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetcher?: typeof fetch;
}): Promise<CanvaTokenResponse> =>
  requestToken(input.fetcher ?? fetch, input.clientId, input.clientSecret, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });

/** PKCE (S256) pair for the authorization request; codeVerifier must stay server-side. */
export const generateCanvaPkce = (): Readonly<{ codeVerifier: string; codeChallenge: string }> => {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
};

export const canvaAuthorizationUrl = (input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
}): string => {
  const url = new URL("https://www.canva.com/api/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

/** The Canva account id (team_user.user_id) behind an access token. */
export const fetchCanvaAccountId = async (input: {
  accessToken: string;
  fetcher?: typeof fetch;
}): Promise<string> => {
  const response = await (input.fetcher ?? fetch)("https://api.canva.com/rest/v1/users/me", {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) throw new CanvaTokenRequestError(response.status);
  const body = (await response.json()) as { team_user?: { user_id?: unknown } };
  if (typeof body.team_user?.user_id !== "string")
    throw new Error("canva_account_response_invalid");
  return body.team_user.user_id;
};
