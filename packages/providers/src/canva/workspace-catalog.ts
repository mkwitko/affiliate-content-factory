import type { WorkspaceId } from "@money-maker/contracts";
import type { DesignExporter } from "@money-maker/core/assets/design-exporter";
import { EncryptedSecretStore } from "../secrets/encrypted-secret-store.js";
import { PrismaProviderConnectionRepository } from "../database/provider-connection-repository.js";
import { PrismaSecretRecordRepository } from "../database/secret-record-repository.js";
import type { DatabaseClient } from "../database/client.js";
import { CanvaDesignExporter } from "./design-exporter.js";
import { createCanvaClientForWorkspace } from "./workspace-client.js";

/**
 * Builds a per-workspace DesignExporter that resolves the workspace's own Canva OAuth
 * connection on every call. App credentials (client id/secret) are global, unlike Mercado
 * Livre's per-workspace app credentials. Mirrors mercado-livre/workspace-catalog.ts.
 */
export const createCanvaDesignExporterForWorkspace =
  (deps: {
    client: DatabaseClient;
    secretStoreMasterKey: Buffer;
    clientId: string;
    clientSecret: string;
  }) =>
  (workspaceId: WorkspaceId): DesignExporter => {
    const secretStore = new EncryptedSecretStore(
      new PrismaSecretRecordRepository(deps.client, workspaceId),
      deps.secretStoreMasterKey,
    );
    const providerConnections = new PrismaProviderConnectionRepository(deps.client);
    return {
      exportPages: async (input) => {
        const connections = await providerConnections.findAllForWorkspace({ workspaceId });
        const connection = connections.find(
          (candidate) => candidate.provider === "canva" && candidate.status === "active",
        );
        if (!connection) throw new Error("canva_not_connected");
        const client = createCanvaClientForWorkspace({
          secretStore,
          connection,
          clientId: deps.clientId,
          clientSecret: deps.clientSecret,
        });
        return new CanvaDesignExporter(client).exportPages(input);
      },
    };
  };
