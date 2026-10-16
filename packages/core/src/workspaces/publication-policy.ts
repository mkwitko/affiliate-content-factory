import type { WorkspaceId } from "@money-maker/contracts";

export type PublicationPolicyMode = "manual" | "policy_based" | "paused";

export type PublicationPolicy = Readonly<{
  workspaceId: WorkspaceId;
  mode: PublicationPolicyMode;
  version: number;
  maxPublicationsPerPeriod?: number;
  maxCostMinorPerItem?: number;
  maxCostMinorPerPeriod?: number;
  periodHours?: number;
  allowedChannels?: readonly string[];
  allowedNiches?: readonly string[];
  allowedOffers?: readonly string[];
  allowedFormats?: readonly string[];
  allowedLanguages?: readonly string[];
  allowedClaimKeys?: readonly string[];
  evidenceMaxAgeDays?: number;
}>;

export const createDefaultPublicationPolicy = (workspaceId: WorkspaceId): PublicationPolicy =>
  Object.freeze({ workspaceId, mode: "manual" as const, version: 1 });

export const changePublicationPolicy = (
  policy: PublicationPolicy,
  mode: PublicationPolicyMode,
  limits: Partial<Omit<PublicationPolicy, "workspaceId" | "mode" | "version">> = {},
): PublicationPolicy => {
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new Error("Publication policy version is invalid");
  }
  return Object.freeze({
    ...policy,
    ...limits,
    workspaceId: policy.workspaceId,
    mode,
    version: policy.version + 1,
  });
};

export type PolicyCandidate = Readonly<{
  channelId: string;
  nicheId: string;
  offerId: string | null;
  format: string;
  language: string;
  claimKeys: readonly string[];
  evidenceVerifiedAt: Date;
  now?: Date;
}>;
export type PolicyUsage = Readonly<{
  publicationsInPeriod: number;
  itemCostMinor: number;
  periodCostMinor: number;
}>;
export type PolicyRejectionCode =
  | "evidence_expired"
  | "channel_not_allowed"
  | "niche_not_allowed"
  | "offer_not_allowed"
  | "format_not_allowed"
  | "language_not_allowed"
  | "claim_not_allowed"
  | "publication_limit"
  | "item_cost_limit"
  | "period_cost_limit"
  | "policy_paused"
  | "policy_revoked";
export type PolicyDecision = Readonly<
  | { allowed: true }
  | {
      allowed: false;
      code: PolicyRejectionCode;
    }
>;
export const evaluateAutomationPolicy = (
  policy: PublicationPolicy,
  candidate: PolicyCandidate,
  usage: PolicyUsage,
): PolicyDecision => {
  if (policy.mode === "paused") return { allowed: false, code: "policy_paused" };
  const age = (candidate.now ?? new Date()).getTime() - candidate.evidenceVerifiedAt.getTime();
  if (policy.evidenceMaxAgeDays !== undefined && age > policy.evidenceMaxAgeDays * 86_400_000)
    return { allowed: false, code: "evidence_expired" };
  const checks: Array<[readonly string[] | undefined, string, PolicyRejectionCode]> = [
    [policy.allowedChannels, candidate.channelId, "channel_not_allowed"],
    [policy.allowedNiches, candidate.nicheId, "niche_not_allowed"],
    [policy.allowedFormats, candidate.format, "format_not_allowed"],
    [policy.allowedLanguages, candidate.language, "language_not_allowed"],
  ];
  for (const [allowed, value, code] of checks)
    if (allowed && !allowed.includes(value)) return { allowed: false, code };
  if (
    candidate.offerId !== null &&
    policy.allowedOffers &&
    !policy.allowedOffers.includes(candidate.offerId)
  )
    return { allowed: false, code: "offer_not_allowed" };
  if (
    policy.allowedClaimKeys &&
    candidate.claimKeys.some((key) => !policy.allowedClaimKeys?.includes(key))
  )
    return { allowed: false, code: "claim_not_allowed" };
  if (
    policy.maxPublicationsPerPeriod !== undefined &&
    usage.publicationsInPeriod >= policy.maxPublicationsPerPeriod
  )
    return { allowed: false, code: "publication_limit" };
  if (policy.maxCostMinorPerItem !== undefined && usage.itemCostMinor > policy.maxCostMinorPerItem)
    return { allowed: false, code: "item_cost_limit" };
  if (
    policy.maxCostMinorPerPeriod !== undefined &&
    usage.periodCostMinor + usage.itemCostMinor > policy.maxCostMinorPerPeriod
  )
    return { allowed: false, code: "period_cost_limit" };
  return { allowed: true };
};
