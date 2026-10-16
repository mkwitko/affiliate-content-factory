import type { WorkspaceId } from "@money-maker/contracts";

export type ProviderName =
  | "post_for_me"
  | "mercado_livre"
  | "canva"
  | "modal"
  | "vercel_ai_gateway";
export type ProviderConnectionMode = "api_key" | "oauth";
export type ProviderConnectionStatus = "active" | "revoked" | "unhealthy";

export type ProviderConnection = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderName;
  mode: ProviderConnectionMode;
  secretReference: string;
  accountId: string;
  platform?: string;
  /** Human-readable label for the account (e.g. the Instagram handle); accountId stays the provider's real id. */
  displayName?: string;
  status: ProviderConnectionStatus;
  webhookId?: string;
  webhookSecretReference?: string;
}>;

type CreateProviderConnectionInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  provider: ProviderName;
  mode: ProviderConnectionMode;
  secretReference: string;
  accountId: string;
  platform?: string;
  displayName?: string;
}>;

export const createProviderConnection = (
  input: CreateProviderConnectionInput,
): ProviderConnection => {
  if (input.secretReference.trim().length === 0) {
    throw new Error("Provider connection secret reference is required.");
  }
  if (input.accountId.trim().length === 0) {
    throw new Error("Provider connection account ID is required.");
  }
  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    provider: input.provider,
    mode: input.mode,
    secretReference: input.secretReference,
    accountId: input.accountId,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    status: "active" as const,
  });
};

export const revokeProviderConnection = (connection: ProviderConnection): ProviderConnection =>
  Object.freeze({ ...connection, status: "revoked" as const });
