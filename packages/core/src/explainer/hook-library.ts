/** Closed hook taxonomy for explainers; performance is later compared per hook type. */
export const HOOK_TYPES = [
  "contrarian",
  "curiosity_gap",
  "what_if",
  "hidden_reason",
  "surprising_fact",
  "money_question",
  "everyday_mystery",
  "mistake",
  "secret_system",
  "cause_effect",
  "myth_bust",
  "number_proof",
] as const;
export type HookType = (typeof HOOK_TYPES)[number];
export const isHookType = (value: unknown): value is HookType =>
  typeof value === "string" && (HOOK_TYPES as readonly string[]).includes(value);
