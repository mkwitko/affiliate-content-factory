import type { WorkspaceId } from "@money-maker/contracts";
import {
  cloudGenerationAllowed,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import type { BudgetPolicy } from "@money-maker/core/costs/generation-budget";
import {
  budgetPoliciesFor,
  DEFAULT_GENERATION_SETTINGS,
  type GenerationSettingsRepository,
} from "@money-maker/core/costs/generation-settings";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { ModalCredentials } from "@money-maker/providers/cloud-gpu/modal-scene-clip-generator";
import { cloudGpuProvidersFor } from "./scene-generator.js";

export type ModalSetup = Readonly<{
  credentials: ModalCredentials;
  policies: readonly BudgetPolicy[];
  source: "connection" | "env";
}>;

export const parseModalSecret = (raw: string): ModalCredentials | null => {
  try {
    const value = JSON.parse(raw) as { tokenId?: unknown; tokenSecret?: unknown };
    return typeof value.tokenId === "string" && typeof value.tokenSecret === "string"
      ? { tokenId: value.tokenId, tokenSecret: value.tokenSecret }
      : null;
  } catch {
    return null;
  }
};

/**
 * Modal for one workspace at job time (spec 2026-10-14): the owner's connection in the secret
 * store first; the pilot's environment variables as a fallback until production moves over.
 * Never under GENERATION_POLICY=local_only.
 */
export const modalSetupFor = async (
  deps: Readonly<{
    connections: Pick<ProviderConnectionRepository, "findAllForWorkspace">;
    secrets: (workspaceId: WorkspaceId) => Pick<SecretStore, "get">;
    settings: Pick<GenerationSettingsRepository, "get">;
    env: Readonly<Record<string, string | undefined>>;
    now: () => Date;
  }>,
  workspaceId: WorkspaceId,
): Promise<ModalSetup | null> => {
  if (!cloudGenerationAllowed(parseGenerationPolicy(deps.env.GENERATION_POLICY))) return null;
  const settings = (await deps.settings.get(workspaceId)) ?? DEFAULT_GENERATION_SETTINGS;
  const policies = budgetPoliciesFor(settings, "modal", deps.now());
  const connections = await deps.connections.findAllForWorkspace({ workspaceId });
  const modals = connections.filter((connection) => connection.provider === "modal");
  // A reconnect leaves the old row revoked: the active one wins; only revoked rows mean "off".
  const modal = modals.find((connection) => connection.status === "active");
  if (!modal && modals.length > 0) return null;
  if (modal) {
    const raw = await deps.secrets(workspaceId).get(modal.secretReference);
    const credentials = raw ? parseModalSecret(raw) : null;
    return credentials ? { credentials, policies, source: "connection" } : null;
  }
  const { MODAL_TOKEN_ID, MODAL_TOKEN_SECRET } = deps.env;
  if (!cloudGpuProvidersFor(deps.env).includes("modal") || !MODAL_TOKEN_ID || !MODAL_TOKEN_SECRET)
    return null;
  // The pilot env never declared a free credit: paid month only.
  return {
    credentials: { tokenId: MODAL_TOKEN_ID, tokenSecret: MODAL_TOKEN_SECRET },
    policies: policies.filter((policy) => policy.key.startsWith("paid-")),
    source: "env",
  };
};
