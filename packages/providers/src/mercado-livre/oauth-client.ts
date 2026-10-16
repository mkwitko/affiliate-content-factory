export class MercadoLivreTokenRequestError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super("mercado_livre_token_request_failed");
    this.name = "MercadoLivreTokenRequestError";
    this.status = status;
  }
}

export type MercadoLivreTokenResponse = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}>;

type RawTokenResponse = Readonly<{
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
}>;

const parseTokenResponse = (body: RawTokenResponse): MercadoLivreTokenResponse => {
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number" ||
    (typeof body.user_id !== "string" && typeof body.user_id !== "number")
  ) {
    throw new Error("mercado_livre_token_response_invalid");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    userId: String(body.user_id),
  };
};

const requestToken = async (
  fetcher: typeof fetch,
  params: Record<string, string>,
): Promise<MercadoLivreTokenResponse> => {
  const response = await fetcher("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new MercadoLivreTokenRequestError(response.status);
  return parseTokenResponse((await response.json()) as RawTokenResponse);
};

export const exchangeMercadoLivreAuthorizationCode = async (input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  fetcher?: typeof fetch;
}): Promise<MercadoLivreTokenResponse> =>
  requestToken(input.fetcher ?? fetch, {
    grant_type: "authorization_code",
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });

export const refreshMercadoLivreAccessToken = async (input: {
  appId: string;
  appSecret: string;
  refreshToken: string;
  fetcher?: typeof fetch;
}): Promise<MercadoLivreTokenResponse> =>
  requestToken(input.fetcher ?? fetch, {
    grant_type: "refresh_token",
    client_id: input.appId,
    client_secret: input.appSecret,
    refresh_token: input.refreshToken,
  });

export const mercadoLivreAuthorizationUrl = (input: {
  appId: string;
  redirectUri: string;
  state: string;
}): string => {
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
};

/** Best-effort display name for a connection; returns undefined instead of failing the connect. */
export const fetchMercadoLivreNickname = async (input: {
  accessToken: string;
  fetcher?: typeof fetch;
}): Promise<string | undefined> => {
  try {
    const response = await (input.fetcher ?? fetch)("https://api.mercadolibre.com/users/me", {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { nickname?: unknown };
    return typeof body.nickname === "string" && body.nickname ? body.nickname : undefined;
  } catch {
    return undefined;
  }
};
