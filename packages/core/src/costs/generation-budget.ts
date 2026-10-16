import type { WorkspaceId } from "@money-maker/contracts";

/**
 * Paid-generation budget (spec 2026-10-09 cloud GPU pilot, phase P1). Money is integer BRL
 * centavos. The ledger rows live in cost_events with a budget key; legacy cost events (no budget
 * key) never count here. Admission is fail-closed: anything missing or unknown rejects.
 */
export type BudgetPolicy = Readonly<{
  /** Stored on each reservation; one key per authorized period. */
  key: string;
  capMinor: number;
  /** ISO 4217 of capMinor; BRL when absent (a free credit is in the provider's currency). */
  currency?: string;
  /** Inclusive. */
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
  /** A reservation older than this with no settlement counts as an unknown outcome. */
  reservationTtlMs: number;
  /** Providers the owner enabled for paid runs; empty admits nothing. */
  providers: readonly string[];
}>;

/**
 * Owner ceiling: R$100 new spend from 2026-10-10 to 2026-11-08 (America/Sao_Paulo, UTC-3 with no
 * DST since 2019). The worst case of each run (cold start, GPU, CPU, memory, FX and margin) counts
 * against the cap; there is no per-generation cap (owner decision 2026-10-14). No provider is
 * enabled here: the worker enables one only through CLOUD_GPU_PROVIDERS, a separate owner decision.
 */
export const CLOUD_GPU_PILOT_BUDGET: BudgetPolicy = Object.freeze({
  key: "cloud-gpu-pilot-2026-10",
  capMinor: 10_000,
  startsAt: new Date("2026-10-10T03:00:00Z"),
  endsAt: new Date("2026-11-09T03:00:00Z"),
  reservationTtlMs: 2 * 60 * 60 * 1000,
  providers: Object.freeze([]) as readonly string[],
});

export type GenerationQuote = Readonly<{
  provider: string;
  model: string;
  revision: string;
  /** ISO 4217 of the provider's price. */
  sourceCurrency: string;
  /** Worst case in the provider's minor units: cold start, idle window, run, storage, egress. */
  sourceMinor: number;
  /** BRL per one unit of sourceCurrency; required unless sourceCurrency is BRL. */
  fxRate?: number;
  fxSource?: string;
  fxAt?: Date;
  /** IOF, card spread and similar headroom on top of the converted price. */
  taxMarginBps: number;
  quotedAt: Date;
  expiresAt: Date;
}>;

export type BudgetStatus = "reserved" | "settled" | "unresolved" | "released";
export type BudgetEntry = Readonly<{
  status: BudgetStatus;
  estimatedMinor: number;
  actualMinor?: number;
  expiresAt?: Date;
}>;
export type BudgetRejection =
  | "quote_invalid"
  | "provider_unsupported"
  | "outside_budget_period"
  | "quote_stale"
  | "fx_unavailable"
  | "unknown_outcome_pending"
  | "budget_exhausted"
  | "currency_mismatch";
export type Admission =
  | Readonly<{ admitted: true; reserveMinor: number; expiresAt: Date }>
  | Readonly<{ admitted: false; reason: BudgetRejection }>;

/** PTAX is published on business days only; a Friday rate must still price a Monday job. */
const FX_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const isMinor = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Worst-case BRL centavos for a quote, rounded up; null when the FX rate is missing. */
export const quoteBrlMinor = (quote: GenerationQuote): number | null => {
  const rate = quote.sourceCurrency === "BRL" ? 1 : quote.fxRate;
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.ceil((quote.sourceMinor * rate * (10_000 + quote.taxMarginBps)) / 10_000);
};

/** An outcome nobody can prove yet: unresolved, or a reservation past its TTL. */
export const isUnknown = (entry: BudgetEntry, now: Date) =>
  entry.status === "unresolved" ||
  (entry.status === "reserved" &&
    (entry.expiresAt === undefined || entry.expiresAt.getTime() <= now.getTime()));

export const spendSummary = (entries: readonly BudgetEntry[], policy: BudgetPolicy, now: Date) => {
  let settledMinor = 0;
  let reservedMinor = 0;
  let unknownMinor = 0;
  for (const entry of entries) {
    if (entry.status === "settled") settledMinor += entry.actualMinor ?? entry.estimatedMinor;
    else if (isUnknown(entry, now)) unknownMinor += entry.estimatedMinor;
    else if (entry.status === "reserved") reservedMinor += entry.estimatedMinor;
  }
  return {
    settledMinor,
    reservedMinor,
    unknownMinor,
    remainingMinor: policy.capMinor - settledMinor - reservedMinor - unknownMinor,
  };
};

/** Pure admission rule: settled + reserved + unknown + worst-case quote <= cap. */
export const admitGenerationSpend = (input: {
  policy: BudgetPolicy;
  entries: readonly BudgetEntry[];
  quote: GenerationQuote;
  now: Date;
}): Admission => {
  const { policy, quote, now } = input;
  const reject = (reason: BudgetRejection): Admission => ({ admitted: false, reason });
  if (
    !isMinor(quote.sourceMinor) ||
    !Number.isSafeInteger(quote.taxMarginBps) ||
    quote.taxMarginBps < 0
  )
    return reject("quote_invalid");
  if (!policy.providers.includes(quote.provider)) return reject("provider_unsupported");
  const at = now.getTime();
  if (at < policy.startsAt.getTime() || at >= policy.endsAt.getTime())
    return reject("outside_budget_period");
  if (quote.quotedAt.getTime() > at || quote.expiresAt.getTime() <= at)
    return reject("quote_stale");
  let reserveMinor: number | null;
  if ((policy.currency ?? "BRL") === "BRL") {
    if (
      quote.sourceCurrency !== "BRL" &&
      (!quote.fxSource || !quote.fxAt || at - quote.fxAt.getTime() > FX_MAX_AGE_MS)
    )
      return reject("fx_unavailable");
    reserveMinor = quoteBrlMinor(quote);
    if (reserveMinor === null) return reject("fx_unavailable");
  } else {
    // A free credit is counted in the provider's own currency: no FX, same margin.
    if (quote.sourceCurrency !== policy.currency) return reject("currency_mismatch");
    reserveMinor = Math.ceil((quote.sourceMinor * (10_000 + quote.taxMarginBps)) / 10_000);
  }
  if (input.entries.some((entry) => isUnknown(entry, now)))
    return reject("unknown_outcome_pending");
  if (reserveMinor > spendSummary(input.entries, policy, now).remainingMinor)
    return reject("budget_exhausted");
  return { admitted: true, reserveMinor, expiresAt: new Date(at + policy.reservationTtlMs) };
};

/**
 * The rows one admission sees: its own budget, plus any unknown outcome of the same provider in
 * another budget (an earlier month, or a free credit that may really have been billed), so an
 * unproven charge keeps blocking new runs until it is reconciled.
 */
export const admissionEntries = (
  workspaceRows: readonly BudgetReservation[],
  input: Readonly<{ policy: BudgetPolicy; quote: GenerationQuote; now: Date }>,
): readonly BudgetReservation[] =>
  workspaceRows.filter(
    (row) =>
      row.budgetKey === input.policy.key ||
      (row.provider === input.quote.provider && isUnknown(row, input.now)),
  );

export type BudgetAction = "settle" | "mark_unknown" | "release";
/**
 * Allowed moves. An unknown outcome is never released: it is settled after reconciliation with
 * the provider's billing (0 when nothing was charged). Repeating a finished move is a no-op.
 */
export const nextBudgetStatus = (
  current: BudgetStatus,
  action: BudgetAction,
): BudgetStatus | null => {
  if (action === "settle") return current === "released" ? null : "settled";
  if (action === "mark_unknown")
    return current === "reserved" || current === "unresolved" ? "unresolved" : null;
  return current === "reserved" || current === "released" ? "released" : null;
};

export type BudgetReservation = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  operationKey: string;
  budgetKey: string;
  provider: string;
  operation: string;
  estimatedMinor: number;
  actualMinor?: number;
  /** ISO 4217 of the amounts; a free credit is in the provider's currency. */
  currency?: string;
  status: BudgetStatus;
  expiresAt: Date;
  receipt?: string;
}>;
export type ReserveResult =
  | Readonly<{ status: "admitted" | "duplicate"; reservation: BudgetReservation }>
  | Readonly<{ status: "rejected"; reason: BudgetRejection }>;
type Key = Readonly<{ workspaceId: WorkspaceId; operationKey: string }>;

export interface GenerationBudgetLedger {
  /** Atomic per workspace and budget key; a repeated operation key returns its reservation. */
  reserve(input: {
    workspaceId: WorkspaceId;
    operationKey: string;
    operation: string;
    quote: GenerationQuote;
    policy: BudgetPolicy;
    now: Date;
  }): Promise<ReserveResult>;
  /** Null when the reservation is missing or the move is not allowed. */
  settle(input: Key & { actualMinor: number; receipt: string }): Promise<BudgetReservation | null>;
  markUnknown(input: Key): Promise<BudgetReservation | null>;
  release(input: Key): Promise<BudgetReservation | null>;
  /** Stores the provider's run id on an open reservation, so it can be resumed or reconciled. */
  recordRun(input: Key & { runRef: string }): Promise<BudgetReservation | null>;
  /** Every reservation of one budget for a workspace, oldest first. */
  list(input: {
    workspaceId: WorkspaceId;
    budgetKey: string;
  }): Promise<readonly BudgetReservation[]>;
}

export const assertMinor = (value: number) => {
  if (!isMinor(value)) throw new Error("invalid_cost");
};

/** Tests and dry runs. Calls run one at a time, like the database lock. */
export const createInMemoryGenerationBudgetLedger = (): GenerationBudgetLedger => {
  const rows: BudgetReservation[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => T): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const find = (key: Key) =>
    rows.findIndex(
      (row) => row.workspaceId === key.workspaceId && row.operationKey === key.operationKey,
    );
  const move = (key: Key, action: BudgetAction, patch: Partial<BudgetReservation> = {}) =>
    serial(() => {
      const index = find(key);
      const row = rows[index];
      const status = row && nextBudgetStatus(row.status, action);
      if (!row || !status) return null;
      if (row.status === status && action !== "mark_unknown") return row;
      rows[index] = { ...row, ...patch, status };
      return rows[index];
    });
  return {
    reserve: (input) =>
      serial((): ReserveResult => {
        const existing = rows[find(input)];
        if (existing) return { status: "duplicate", reservation: existing };
        const admission = admitGenerationSpend({
          policy: input.policy,
          quote: input.quote,
          now: input.now,
          entries: admissionEntries(
            rows.filter((row) => row.workspaceId === input.workspaceId),
            input,
          ),
        });
        if (!admission.admitted) return { status: "rejected", reason: admission.reason };
        const reservation: BudgetReservation = {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          operationKey: input.operationKey,
          budgetKey: input.policy.key,
          provider: input.quote.provider,
          operation: input.operation,
          estimatedMinor: admission.reserveMinor,
          currency: input.policy.currency ?? "BRL",
          status: "reserved",
          expiresAt: admission.expiresAt,
        };
        rows.push(reservation);
        return { status: "admitted", reservation };
      }),
    settle: async (input) => {
      assertMinor(input.actualMinor);
      return move(input, "settle", { actualMinor: input.actualMinor, receipt: input.receipt });
    },
    markUnknown: (input) => move(input, "mark_unknown"),
    // A reservation with a recorded run may have been billed: reconcile it, never release it.
    release: (input) =>
      rows[find(input)]?.receipt ? Promise.resolve(null) : move(input, "release"),
    recordRun: (input) =>
      serial(() => {
        const index = find(input);
        const row = rows[index];
        if (!row || (row.status !== "reserved" && row.status !== "unresolved")) return null;
        rows[index] = { ...row, receipt: input.runRef };
        return rows[index];
      }),
    list: async (input) =>
      rows.filter(
        (row) => row.workspaceId === input.workspaceId && row.budgetKey === input.budgetKey,
      ),
  };
};
