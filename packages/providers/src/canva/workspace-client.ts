import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import { createCanvaClient, type CanvaClient } from "./client.js";
import { CanvaTokenRequestError, refreshCanvaAccessToken } from "./oauth-client.js";

export type StoredCanvaTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}>;

// ponytail: fixed 5-minute refresh buffer; make configurable if a provider ever needs a different margin.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ponytail: process-local lock keyed by secretReference so concurrent callers on this
// instance share one refresh (the Canva refresh token is single-use, same reasoning as
// packages/providers/src/mercado-livre/workspace-client.ts). Ceiling: multiple API instances
// can still race each other; upgrade to pg_advisory_xact_lock(secretReference) if that
// throughput matters.
const refreshLocks = new Map<string, Promise<string>>();

const parseStoredTokens = (raw: string | null): StoredCanvaTokens => {
  if (!raw) throw new Error("canva_not_connected");
  let parsed: Partial<StoredCanvaTokens>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredCanvaTokens>;
  } catch {
    throw new Error("canva_not_connected");
  }
  if (!parsed.accessToken || !parsed.refreshToken || !parsed.accessTokenExpiresAt) {
    throw new Error("canva_not_connected");
  }
  return parsed as StoredCanvaTokens;
};

export const createCanvaClientForWorkspace = (deps: {
  secretStore: SecretStore;
  connection: ProviderConnection;
  clientId: string;
  clientSecret: string;
  now?: () => Date;
  fetcher?: typeof fetch;
}): CanvaClient => {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? fetch;

  const refreshAndStore = async (
    secretReference: string,
    stored: StoredCanvaTokens,
  ): Promise<string> => {
    let refreshed: Awaited<ReturnType<typeof refreshCanvaAccessToken>>;
    try {
      refreshed = await refreshCanvaAccessToken({
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        refreshToken: stored.refreshToken,
        fetcher,
      });
    } catch (error) {
      if (
        error instanceof CanvaTokenRequestError &&
        (error.status === 400 || error.status === 401)
      ) {
        // The stored refresh token was rotated elsewhere, revoked, or expired: the workspace
        // was connected once, so ask the operator to reconnect rather than to connect.
        throw new Error("canva_token_invalid");
      }
      throw error;
    }
    // Canva refresh tokens are single-use and rotate: always persist the new one.
    const next: StoredCanvaTokens = {
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
    exportPages: async (input) => {
      const accessToken = await resolveAccessToken();
      return createCanvaClient({ accessToken, fetcher }).exportPages(input);
    },
  };
};
