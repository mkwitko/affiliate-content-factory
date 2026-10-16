import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { MercadoLivreClient, MercadoLivreResponse } from "./client.js";
import { MercadoLivreTokenRequestError, refreshMercadoLivreAccessToken } from "./oauth-client.js";

export type StoredMercadoLivreTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}>;

// ponytail: fixed 5-minute refresh buffer; make configurable if a provider ever needs a different margin.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ponytail: process-local lock keyed by secretReference so concurrent callers on this
// instance share one refresh (the ML refresh token is single-use). Ceiling: multiple API
// instances can still race each other; upgrade to pg_advisory_xact_lock(secretReference) if
// that throughput matters. The worker (apps/worker) also calls into this client, but it
// always runs as a single replica, so it doesn't add another process to race against.
const refreshLocks = new Map<string, Promise<string>>();

const parseStoredTokens = (raw: string | null): StoredMercadoLivreTokens => {
  if (!raw) throw new Error("mercado_livre_not_connected");
  let parsed: Partial<StoredMercadoLivreTokens>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredMercadoLivreTokens>;
  } catch {
    throw new Error("mercado_livre_not_connected");
  }
  if (!parsed.accessToken || !parsed.refreshToken || !parsed.accessTokenExpiresAt) {
    throw new Error("mercado_livre_not_connected");
  }
  return parsed as StoredMercadoLivreTokens;
};

export const createMercadoLivreClientForWorkspace = (deps: {
  secretStore: SecretStore;
  connection: ProviderConnection;
  appId: string;
  appSecret: string;
  now?: () => Date;
  fetcher?: typeof fetch;
}): MercadoLivreClient => {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? fetch;

  const refreshAndStore = async (
    secretReference: string,
    stored: StoredMercadoLivreTokens,
  ): Promise<string> => {
    let refreshed: Awaited<ReturnType<typeof refreshMercadoLivreAccessToken>>;
    try {
      refreshed = await refreshMercadoLivreAccessToken({
        appId: deps.appId,
        appSecret: deps.appSecret,
        refreshToken: stored.refreshToken,
        fetcher,
      });
    } catch (error) {
      if (
        error instanceof MercadoLivreTokenRequestError &&
        (error.status === 400 || error.status === 401)
      ) {
        throw new Error("mercado_livre_not_connected");
      }
      throw error;
    }
    const next: StoredMercadoLivreTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExpiresAt: new Date(now().getTime() + refreshed.expiresIn * 1000).toISOString(),
    };
    await deps.secretStore.put({ reference: secretReference, secret: JSON.stringify(next) });
    return next.accessToken;
  };

  const resolveAccessToken = async (): Promise<string> => {
    const secretReference = deps.connection.secretReference;
    const pending = refreshLocks.get(secretReference);
    if (pending) return pending;

    // Set synchronously (before any await) so a concurrent call sees the lock
    // instead of racing this one to its own refresh.
    const resolution = (async () => {
      const stored = parseStoredTokens(await deps.secretStore.get(secretReference));
      const expiresAt = new Date(stored.accessTokenExpiresAt).getTime();
      if (expiresAt - now().getTime() > REFRESH_BUFFER_MS) return stored.accessToken;
      return refreshAndStore(secretReference, stored);
    })();
    refreshLocks.set(secretReference, resolution);
    try {
      return await resolution;
    } finally {
      refreshLocks.delete(secretReference);
    }
  };

  return {
    request: async (path, init): Promise<MercadoLivreResponse> => {
      const accessToken = await resolveAccessToken();
      return fetcher(new URL(path, "https://api.mercadolibre.com").toString(), {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${accessToken}` },
      });
    },
  };
};
