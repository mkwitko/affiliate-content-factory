export const NEURONS_PER_SCENE = 173;
export const DAILY_NEURON_ALLOWANCE = 10_000;

export type BudgetDecision = "generate" | "reuse_only" | "procedural_only";

export const decideSceneBudget = (usedToday: number): BudgetDecision => {
  if (usedToday < DAILY_NEURON_ALLOWANCE * 0.8) return "generate";
  if (usedToday < DAILY_NEURON_ALLOWANCE * 0.95) return "reuse_only";
  return "procedural_only";
};

export const utcDayStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
