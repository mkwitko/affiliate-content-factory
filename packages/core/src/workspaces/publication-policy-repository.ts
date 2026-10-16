import type { WorkspaceId } from "@money-maker/contracts";
import type { PublicationPolicy } from "./publication-policy.js";

export interface PublicationPolicyRepository {
  findForWorkspace(workspaceId: WorkspaceId): Promise<PublicationPolicy>;
  create(policy: PublicationPolicy): Promise<PublicationPolicy>;
  update(policy: PublicationPolicy): Promise<PublicationPolicy>;
  reservePolicyUse?(input: {
    workspaceId: WorkspaceId;
    policyVersion: number;
    periodKey: string;
    itemCostMinor: number;
  }): Promise<{ ok: boolean; reason?: string }>;
}
