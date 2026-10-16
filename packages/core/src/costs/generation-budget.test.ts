import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  admitGenerationSpend,
  type BudgetPolicy,
  CLOUD_GPU_PILOT_BUDGET,
  createInMemoryGenerationBudgetLedger,
  type GenerationQuote,
  quoteBrlMinor,
  spendSummary,
} from "./generation-budget.js";

const now = new Date("2026-10-15T12:00:00Z");
const policy: BudgetPolicy = { ...CLOUD_GPU_PILOT_BUDGET, providers: ["fake"] };
const quote = (overrides: Partial<GenerationQuote> = {}): GenerationQuote => ({
  provider: "fake",
  model: "fake/i2v",
  revision: "r1",
  sourceCurrency: "BRL",
  sourceMinor: 1_000,
  taxMarginBps: 0,
  quotedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 60_000),
  ...overrides,
});
const first = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const second = parseWorkspaceId("d4e547be-76e0-48a4-8472-4fcbec69e689");

describe("CLOUD_GPU_PILOT_BUDGET", () => {
  it("caps the pilot at R$100 from 2026-10-10 to 2026-11-08 in Sao Paulo time, no provider enabled", () => {
    expect(CLOUD_GPU_PILOT_BUDGET.capMinor).toBe(10_000);
    expect(CLOUD_GPU_PILOT_BUDGET.startsAt.toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect(CLOUD_GPU_PILOT_BUDGET.endsAt.toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(CLOUD_GPU_PILOT_BUDGET.providers).toEqual([]);
    expect(
      admitGenerationSpend({ policy: CLOUD_GPU_PILOT_BUDGET, entries: [], quote: quote(), now }),
    ).toEqual({ admitted: false, reason: "provider_unsupported" });
  });
});

describe("quoteBrlMinor", () => {
  it("converts with FX and tax headroom, rounding up", () => {
    expect(
      quoteBrlMinor(
        quote({ sourceCurrency: "USD", sourceMinor: 100, fxRate: 5.431, taxMarginBps: 638 }),
      ),
    ).toBe(578);
  });
  it("is null without FX for a foreign currency", () => {
    expect(quoteBrlMinor(quote({ sourceCurrency: "USD" }))).toBeNull();
  });
});

describe("admitGenerationSpend", () => {
  const admit = (entries: Parameters<typeof admitGenerationSpend>[0]["entries"], q = quote()) =>
    admitGenerationSpend({ policy, entries, quote: q, now });

  it("admits up to exactly the cap and rejects one centavo over", () => {
    const spent = [{ status: "settled" as const, estimatedMinor: 9_500, actualMinor: 9_000 }];
    expect(admit(spent)).toMatchObject({ admitted: true, reserveMinor: 1_000 });
    expect(admit(spent, quote({ sourceMinor: 1_001 }))).toEqual({
      admitted: false,
      reason: "budget_exhausted",
    });
  });

  it("counts reservations and unresolved runs at their worst case, released ones at zero", () => {
    const entries = [
      {
        status: "reserved" as const,
        estimatedMinor: 4_000,
        expiresAt: new Date(now.getTime() + 1),
      },
      { status: "settled" as const, estimatedMinor: 4_000, actualMinor: 4_000 },
      { status: "released" as const, estimatedMinor: 4_000 },
    ];
    expect(spendSummary(entries, policy, now)).toEqual({
      settledMinor: 4_000,
      reservedMinor: 4_000,
      unknownMinor: 0,
      remainingMinor: 2_000,
    });
    expect(admit(entries, quote({ sourceMinor: 2_001 }))).toMatchObject({
      reason: "budget_exhausted",
    });
  });

  it("blocks every new admission while an outcome is unknown or a reservation expired", () => {
    expect(admit([{ status: "unresolved", estimatedMinor: 10 }])).toEqual({
      admitted: false,
      reason: "unknown_outcome_pending",
    });
    expect(
      admit([{ status: "reserved", estimatedMinor: 10, expiresAt: new Date(now.getTime() - 1) }]),
    ).toEqual({ admitted: false, reason: "unknown_outcome_pending" });
  });

  it.each([
    [quote({ expiresAt: now }), "quote_stale"],
    [quote({ quotedAt: new Date(now.getTime() + 1) }), "quote_stale"],
    [quote({ sourceMinor: 1.5 }), "quote_invalid"],
    [quote({ sourceMinor: -1 }), "quote_invalid"],
    [quote({ taxMarginBps: -1 }), "quote_invalid"],
    [quote({ provider: "runpod" }), "provider_unsupported"],
    [quote({ sourceCurrency: "USD" }), "fx_unavailable"],
    [
      quote({
        sourceCurrency: "USD",
        fxRate: 5.4,
        fxSource: "bcb",
        fxAt: new Date(now.getTime() - 97 * 3_600_000),
      }),
      "fx_unavailable",
    ],
    [quote({ sourceMinor: 10_001 }), "budget_exhausted"],
  ] as const)("rejects %#: %s", (q, reason) => {
    expect(admit([], q)).toEqual({ admitted: false, reason });
  });

  it("rejects outside the budget period", () => {
    expect(
      admitGenerationSpend({
        policy,
        entries: [],
        quote: quote(),
        now: new Date("2026-11-09T03:00:00Z"),
      }),
    ).toEqual({ admitted: false, reason: "outside_budget_period" });
  });
});

describe("pilot limits: R$100 in total, no per-generation cap", () => {
  const pilot: BudgetPolicy = { ...CLOUD_GPU_PILOT_BUDGET, providers: ["fake"] };
  const reserveFive = (
    ledger: ReturnType<typeof createInMemoryGenerationBudgetLedger>,
    operationKey: string,
    sourceMinor = 500,
  ) =>
    ledger.reserve({
      workspaceId: first,
      operationKey,
      operation: "i2v_5s",
      quote: quote({ sourceMinor }),
      policy: pilot,
      now,
    });

  it("admits one generation worth the whole month and refuses one centavo over it", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    expect((await reserveFive(ledger, "over", 10_001)).status).toBe("rejected");
    expect((await reserveFive(ledger, "at", 10_000)).status).toBe("admitted");
  });

  it("admits exactly twenty concurrent R$5 generations and refuses the rest", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => reserveFive(ledger, `job-${index}`)),
    );
    expect(results.filter((result) => result.status === "admitted")).toHaveLength(20);
    expect(
      results.filter(
        (result) => result.status === "rejected" && result.reason === "budget_exhausted",
      ),
    ).toHaveLength(5);
  });

  it("never reserves twice for a re-run of the same operation", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    await reserveFive(ledger, "same");
    await reserveFive(ledger, "same");
    expect(await ledger.list({ workspaceId: first, budgetKey: pilot.key })).toHaveLength(1);
  });

  it("holds an unknown charge at R$5 and blocks until reconciled", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    await reserveFive(ledger, "lost");
    await ledger.recordRun({ workspaceId: first, operationKey: "lost", runRef: "modal:fc-1" });
    await ledger.markUnknown({ workspaceId: first, operationKey: "lost" });
    expect(await reserveFive(ledger, "next")).toEqual({
      status: "rejected",
      reason: "unknown_outcome_pending",
    });
    const [row] = await ledger.list({ workspaceId: first, budgetKey: pilot.key });
    expect(row).toMatchObject({ status: "unresolved", estimatedMinor: 500, receipt: "modal:fc-1" });
    await ledger.settle({
      workspaceId: first,
      operationKey: "lost",
      actualMinor: 37,
      receipt: "bill",
    });
    expect((await reserveFive(ledger, "next")).status).toBe("admitted");
  });
});

describe("in-memory generation budget ledger", () => {
  const reserve = (
    ledger: ReturnType<typeof createInMemoryGenerationBudgetLedger>,
    operationKey: string,
    workspaceId = first,
    sourceMinor = 3_000,
  ) =>
    ledger.reserve({
      workspaceId,
      operationKey,
      operation: "i2v_5s",
      quote: quote({ sourceMinor }),
      policy,
      now,
    });

  it("admits parallel submissions only up to the cap", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((key) => reserve(ledger, key)));
    expect(results.filter((result) => result.status === "admitted")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
  });

  it("returns the same reservation for a duplicate operation key", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const one = await reserve(ledger, "same");
    const two = await reserve(ledger, "same");
    expect(one.status).toBe("admitted");
    expect(two.status).toBe("duplicate");
    if (one.status === "rejected" || two.status === "rejected") throw new Error("unexpected");
    expect(two.reservation.id).toBe(one.reservation.id);
  });

  it("keeps workspaces apart", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    for (const key of ["a", "b", "c"]) await reserve(ledger, key, first);
    expect((await reserve(ledger, "a", second)).status).toBe("admitted");
    expect(
      await ledger.settle({ workspaceId: second, operationKey: "b", actualMinor: 1, receipt: "x" }),
    ).toBeNull();
  });

  it("settles, releases and reconciles through allowed transitions only", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    await reserve(ledger, "ok");
    await reserve(ledger, "cancel");
    await reserve(ledger, "lost");
    const settled = await ledger.settle({
      workspaceId: first,
      operationKey: "ok",
      actualMinor: 2_500,
      receipt: "run-1",
    });
    expect(settled).toMatchObject({ status: "settled", actualMinor: 2_500, receipt: "run-1" });
    expect(await ledger.release({ workspaceId: first, operationKey: "ok" })).toBeNull();
    expect(await ledger.release({ workspaceId: first, operationKey: "cancel" })).toMatchObject({
      status: "released",
    });
    expect(await ledger.release({ workspaceId: first, operationKey: "cancel" })).toMatchObject({
      status: "released",
    });
    expect(await ledger.markUnknown({ workspaceId: first, operationKey: "lost" })).toMatchObject({
      status: "unresolved",
    });
    expect(await ledger.release({ workspaceId: first, operationKey: "lost" })).toBeNull();
    expect((await reserve(ledger, "blocked", first, 1)).status).toBe("rejected");
    expect(
      await ledger.settle({
        workspaceId: first,
        operationKey: "lost",
        actualMinor: 0,
        receipt: "reconciled",
      }),
    ).toMatchObject({ status: "settled", actualMinor: 0 });
    expect((await reserve(ledger, "after", first, 1)).status).toBe("admitted");
  });

  it("rejects a non-integer or negative settlement", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    await reserve(ledger, "x");
    await expect(
      ledger.settle({ workspaceId: first, operationKey: "x", actualMinor: 1.2, receipt: "r" }),
    ).rejects.toThrow("invalid_cost");
  });
});
