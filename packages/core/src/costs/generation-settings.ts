import type { WorkspaceId } from "@money-maker/contracts";
import { type BudgetPolicy, CLOUD_GPU_PILOT_BUDGET } from "./generation-budget.js";

/**
 * Owner-editable generation money settings (spec 2026-10-14, generation orchestrator): the paid
 * cap per São Paulo month and each cloud provider's free credit. Free credit is spent first; the
 * monthly cap is the only money limit (no per-generation cap, owner decision 2026-10-14).
 */
export const CLOUD_PROVIDERS = ["modal"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export type FreeCredit = Readonly<{ amountMinor: number; currency: "USD" }>;
export type GenerationSettings = Readonly<{
  /** BRL centavos per São Paulo calendar month. */
  monthlyCapMinor: number;
  freeCredits: Readonly<Partial<Record<CloudProvider, FreeCredit>>>;
}>;

/** Owner decision 2026-10-14: R$100 per month until the project earns. */
export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = Object.freeze({
  monthlyCapMinor: 10_000,
  freeCredits: Object.freeze({}),
});
/** Input guard (R$1.000), not a business limit: a typo must not open a large budget. */
export const MAX_MONTHLY_CAP_MINOR = 100_000;

export interface GenerationSettingsRepository {
  get(workspaceId: WorkspaceId): Promise<GenerationSettings | null>;
  put(workspaceId: WorkspaceId, settings: GenerationSettings): Promise<void>;
}

const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, no DST since 2019

export const saoPauloMonth = (now: Date) => {
  const local = new Date(now.getTime() - SAO_PAULO_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    label: `${year}-${String(month + 1).padStart(2, "0")}`,
    startsAt: new Date(Date.UTC(year, month, 1) + SAO_PAULO_OFFSET_MS),
    endsAt: new Date(Date.UTC(year, month + 1, 1) + SAO_PAULO_OFFSET_MS),
  };
};

export const paidBudgetPolicy = (
  settings: GenerationSettings,
  providers: readonly string[],
  now: Date,
): BudgetPolicy => {
  const month = saoPauloMonth(now);
  return {
    key: `paid-${month.label}`,
    capMinor: settings.monthlyCapMinor,
    startsAt: month.startsAt,
    endsAt: month.endsAt,
    reservationTtlMs: CLOUD_GPU_PILOT_BUDGET.reservationTtlMs,
    providers,
  };
};

export const freeCreditPolicy = (
  provider: CloudProvider,
  credit: FreeCredit,
  now: Date,
): BudgetPolicy => {
  const month = saoPauloMonth(now);
  return {
    key: `free-${provider}-${month.label}`,
    currency: credit.currency,
    capMinor: credit.amountMinor,
    startsAt: month.startsAt,
    endsAt: month.endsAt,
    reservationTtlMs: CLOUD_GPU_PILOT_BUDGET.reservationTtlMs,
    providers: [provider],
  };
};

/** The order a run tries: the provider's free credit first, then the paid month. */
export const budgetPoliciesFor = (
  settings: GenerationSettings,
  provider: CloudProvider,
  now: Date,
): readonly BudgetPolicy[] => {
  const credit = settings.freeCredits[provider];
  const paid = paidBudgetPolicy(settings, [provider], now);
  return credit && credit.amountMinor > 0
    ? [freeCreditPolicy(provider, credit, now), paid]
    : [paid];
};
