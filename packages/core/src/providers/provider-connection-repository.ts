import type { WorkspaceId } from "@money-maker/contracts";
import type { ProviderConnection } from "./provider-connection.js";

export type { ProviderConnection } from "./provider-connection.js";

export type CreateProviderConnectionResult =
  | Readonly<{ ok: true; connection: ProviderConnection }>
  | Readonly<{ ok: false; code: "duplicate_account" }>;

export interface ProviderConnectionRepository {
  create(connection: ProviderConnection): Promise<CreateProviderConnectionResult>;
  findAllForWorkspace(input: { workspaceId: WorkspaceId }): Promise<readonly ProviderConnection[]>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    connectionId: string;
  }): Promise<ProviderConnection | null>;
  findById?(connectionId: string): Promise<ProviderConnection | null>;
  configureWebhook?(input: {
    workspaceId: WorkspaceId;
    connectionId: string;
    webhookId: string;
    webhookSecretReference: string;
  }): Promise<ProviderConnection | null>;
  revoke(input: { workspaceId: WorkspaceId; connectionId: string }): Promise<void>;
  /** Reactivates a revoked/unhealthy connection with a fresh secret reference (e.g. reconnect after disconnect). */
  reactivate?(input: {
    workspaceId: WorkspaceId;
    connectionId: string;
    secretReference: string;
  }): Promise<ProviderConnection | null>;
}
