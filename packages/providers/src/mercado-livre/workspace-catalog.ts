import type { WorkspaceId } from "@money-maker/contracts";
import type { MarketplaceCatalog } from "@money-maker/core/offers/marketplace-catalog";
import { EncryptedSecretStore } from "../secrets/encrypted-secret-store.js";
import { PrismaProviderConnectionRepository } from "../database/provider-connection-repository.js";
import { PrismaSecretRecordRepository } from "../database/secret-record-repository.js";
import type { DatabaseClient } from "../database/client.js";
import type { MercadoLivreClient } from "./client.js";
import { MercadoLivreCatalog } from "./catalog.js";
import { createMercadoLivreClientForWorkspace } from "./workspace-client.js";

/**
 * Builds a per-workspace, authenticated Mercado Livre client that resolves the workspace's own
 * OAuth connection and app credentials on every call. Shared by the API (MCP tools, connection
 * testing) and the worker (scheduled research), so the OAuth/secret-store wiring lives in one
 * place.
 */
export const createMercadoLivreClientForWorkspaceId =
  (deps: { client: DatabaseClient; secretStoreMasterKey: Buffer }) =>
  (workspaceId: WorkspaceId): MercadoLivreClient => {
    const secretStore = new EncryptedSecretStore(
      new PrismaSecretRecordRepository(deps.client, workspaceId),
      deps.secretStoreMasterKey,
    );
    const providerConnections = new PrismaProviderConnectionRepository(deps.client);
    // ponytail: looks up the connection + app credentials on every call (no in-memory cache);
    // add one if Mercado Livre traffic ever makes the extra round trips measurable.
    const authenticatedRequest: MercadoLivreClient["request"] = async (path, init) => {
      const connections = await providerConnections.findAllForWorkspace({ workspaceId });
      const connection = connections.find(
        (candidate) => candidate.provider === "mercado_livre" && candidate.status === "active",
      );
      if (!connection) throw new Error("mercado_livre_not_connected");
      const credentialsRaw = await secretStore.get(
        `secret://workspace/${workspaceId}/mercado-livre/app-credentials`,
      );
      if (!credentialsRaw) throw new Error("mercado_livre_not_connected");
      const credentials = JSON.parse(credentialsRaw) as { appId: string; appSecret: string };
      const workspaceClient = createMercadoLivreClientForWorkspace({
        secretStore,
        connection,
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      });
      return workspaceClient.request(path, init);
    };
    return { request: authenticatedRequest };
  };

export const createMarketplaceCatalogForWorkspace =
  (deps: { client: DatabaseClient; secretStoreMasterKey: Buffer }) =>
  (workspaceId: WorkspaceId): MarketplaceCatalog =>
    new MercadoLivreCatalog(createMercadoLivreClientForWorkspaceId(deps)(workspaceId));
