import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  admitGenerationSpend,
  type BudgetEntry,
  createInMemoryGenerationBudgetLedger,
  type GenerationQuote,
} from "./generation-budget.js";
import {
  budgetPoliciesFor,
  DEFAULT_GENERATION_SETTINGS,
  freeCreditPolicy,
  paidBudgetPolicy,
  saoPauloMonth,
} from "./generation-settings.js";

const now = new Date("2026-10-14T15:00:00Z");
// exactOptionalPropertyTypes: the FX fields are added, never set to undefined.
const usdQuoteNoFx = (sourceMinor: number): GenerationQuote => ({
  provider: "modal",
  model: "wan",
  revision: "r1",
  sourceCurrency: "USD",
  sourceMinor,
  taxMarginBps: 1_000,
  quotedAt: new Date(now.getTime() - 1_000),
  expiresAt: new Date(now.getTime() + 60_000),
});
const usdQuote = (sourceMinor: number): GenerationQuote => ({
  ...usdQuoteNoFx(sourceMinor),
  fxRate: 5,
  fxSource: "ptax",
  fxAt: now,
});

describe("saoPauloMonth", () => {
  it("puts 23:30 on the last day in São Paulo in that month, not the next", () => {
    const month = saoPauloMonth(new Date("2026-11-01T02:30:00Z"));
    expect(month.label).toBe("2026-10");
    expect(month.startsAt.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(month.endsAt.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  });
  it("rolls December into January", () => {
    expect(saoPauloMonth(new Date("2026-12-15T12:00:00Z")).endsAt.toISOString()).toBe(
      "2027-01-01T03:00:00.000Z",
    );
  });
});

describe("budget policies", () => {
  it("prices a free credit in its own currency without FX", () => {
    const policy = freeCreditPolicy("modal", { amountMinor: 3_000, currency: "USD" }, now);
    expect(policy.key).toBe("free-modal-2026-10");
    const admission = admitGenerationSpend({
      policy,
      entries: [],
      quote: usdQuoteNoFx(200),
      now,
    });
    // 200 US cents + 10 % margin, in US cents.
    expect(admission).toEqual({ admitted: true, reserveMinor: 220, expiresAt: expect.any(Date) });
  });

  it("refuses a quote in another currency than the free credit", () => {
    const policy = freeCreditPolicy("modal", { amountMinor: 3_000, currency: "USD" }, now);
    const admission = admitGenerationSpend({
      policy,
      entries: [],
      quote: { ...usdQuote(200), sourceCurrency: "EUR" },
      now,
    });
    expect(admission).toEqual({ admitted: false, reason: "currency_mismatch" });
  });

  it("refuses paid runs once the owner lowers the cap below this month's spend", () => {
    const policy = paidBudgetPolicy(
      { ...DEFAULT_GENERATION_SETTINGS, monthlyCapMinor: 1_000 },
      ["modal"],
      now,
    );
    const spent: BudgetEntry[] = [{ status: "settled", estimatedMinor: 1_500, actualMinor: 1_500 }];
    expect(admitGenerationSpend({ policy, entries: spent, quote: usdQuote(10), now })).toEqual({
      admitted: false,
      reason: "budget_exhausted",
    });
  });

  it("orders the free credit before the paid month, and paid only without a credit", () => {
    const withCredit = budgetPoliciesFor(
      { monthlyCapMinor: 10_000, freeCredits: { modal: { amountMinor: 3_000, currency: "USD" } } },
      "modal",
      now,
    );
    expect(withCredit.map((policy) => policy.key)).toEqual(["free-modal-2026-10", "paid-2026-10"]);
    expect(withCredit[1]).toMatchObject({
      capMinor: 10_000,
      providers: ["modal"],
    });
    expect(budgetPoliciesFor(DEFAULT_GENERATION_SETTINGS, "modal", now).map((p) => p.key)).toEqual([
      "paid-2026-10",
    ]);
  });
});

describe("ledger guards across budgets", () => {
  const quote = (now: Date): GenerationQuote => ({
    provider: "modal",
    model: "wan",
    revision: "r1",
    sourceCurrency: "BRL",
    sourceMinor: 100,
    taxMarginBps: 0,
    quotedAt: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const key = { workspaceId: parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d") };

  it("keeps last month's unknown outcome blocking this month's paid runs", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const october = new Date("2026-10-31T20:00:00Z");
    const november = new Date("2026-11-02T12:00:00Z");
    const settings = { ...DEFAULT_GENERATION_SETTINGS };
    await ledger.reserve({
      ...key,
      operationKey: "oct",
      operation: "clip",
      quote: quote(october),
      policy: paidBudgetPolicy(settings, ["modal"], october),
      now: october,
    });
    await ledger.markUnknown({ ...key, operationKey: "oct" });
    const novemberRun = await ledger.reserve({
      ...key,
      operationKey: "nov",
      operation: "clip",
      quote: quote(november),
      policy: paidBudgetPolicy(settings, ["modal"], november),
      now: november,
    });
    expect(novemberRun).toEqual({ status: "rejected", reason: "unknown_outcome_pending" });
  });

  it("never releases a reservation whose run was recorded", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    await ledger.reserve({
      ...key,
      operationKey: "run",
      operation: "clip",
      quote: quote(now),
      policy: paidBudgetPolicy(DEFAULT_GENERATION_SETTINGS, ["modal"], now),
      now,
    });
    await ledger.recordRun({ ...key, operationKey: "run", runRef: "modal:fc-1" });
    expect(await ledger.release({ ...key, operationKey: "run" })).toBeNull();
  });
});
