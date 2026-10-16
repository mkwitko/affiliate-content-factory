export const GENERATION_POLICIES = ["local_only", "local_first", "cloud_allowed"] as const;
export type GenerationPolicy = (typeof GENERATION_POLICIES)[number];

export const cloudGenerationAllowed = (policy: GenerationPolicy): boolean =>
  policy !== "local_only";

/** Unset or blank means `cloud_allowed` (today's behavior); anything else must match exactly. */
export const parseGenerationPolicy = (raw: string | undefined): GenerationPolicy => {
  const value = raw?.trim();
  if (!value) return "cloud_allowed";
  const policy = GENERATION_POLICIES.find((candidate) => candidate === value);
  if (!policy) throw new Error("generation_policy_invalid");
  return policy;
};
