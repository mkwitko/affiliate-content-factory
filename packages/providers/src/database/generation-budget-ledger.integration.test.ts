import { parseWorkspaceId } from "@money-maker/contracts";
import {
  type BudgetPolicy,
  CLOUD_GPU_PILOT_BUDGET,
  type GenerationQuote,
} from "@money-maker/core/costs/generation-budget";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaGenerationBudgetLedger } from "./generation-budget-ledger.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

const now = new Date("2026-10-15T12:00:00Z");
const policy: BudgetPolicy = { ...CLOUD_GPU_PILOT_BUDGET, providers: ["fake"] };
const quote: GenerationQuote = {
  provider: "fake",
  model: "fake/i2v",
  revision: "r1",
  sourceCurrency: "BRL",
  sourceMinor: 3_000,
  taxMarginBps: 0,
  quotedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 60_000),
};

integration("PrismaGenerationBudgetLedger", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let ledger: PrismaGenerationBudgetLedger;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    ledger = new PrismaGenerationBudgetLedger(client);
  });

  beforeEach(async () => {
    await client.costEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const workspace = async () =>
    parseWorkspaceId((await client.workspace.create({ data: { name: "Budget" } })).id);
  const reserve = (workspaceId: ReturnType<typeof parseWorkspaceId>, operationKey: string) =>
    ledger.reserve({ workspaceId, operationKey, operation: "i2v_5s", quote, policy, now });

  it("admits concurrent submissions only up to the cap", async () => {
    const workspaceId = await workspace();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => reserve(workspaceId, `job-${index}`)),
    );
    expect(results.filter((result) => result.status === "admitted")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
  });

  it("admits exactly twenty concurrent R$5 pilot generations", async () => {
    const workspaceId = await workspace();
    const pilot: BudgetPolicy = { ...CLOUD_GPU_PILOT_BUDGET, providers: ["fake"] };
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        ledger.reserve({
          workspaceId,
          operationKey: `five-${index}`,
          operation: "i2v_5s",
          quote: { ...quote, sourceMinor: 500 },
          policy: pilot,
          now,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "admitted")).toHaveLength(20);
    const rows = await ledger.list({ workspaceId, budgetKey: pilot.key });
    expect(rows.reduce((sum, row) => sum + row.estimatedMinor, 0)).toBe(10_000);
  });

  it("records the provider run on an open reservation only", async () => {
    const workspaceId = await workspace();
    await reserve(workspaceId, "run");
    expect(
      await ledger.recordRun({ workspaceId, operationKey: "run", runRef: "modal:fc-9" }),
    ).toMatchObject({ status: "reserved", receipt: "modal:fc-9" });
    await ledger.settle({ workspaceId, operationKey: "run", actualMinor: 10, receipt: "bill" });
    expect(await ledger.recordRun({ workspaceId, operationKey: "run", runRef: "x" })).toBeNull();
  });

  it("returns one reservation for concurrent duplicates of an operation key", async () => {
    const workspaceId = await workspace();
    const results = await Promise.all([reserve(workspaceId, "same"), reserve(workspaceId, "same")]);
    expect(results.map((result) => result.status).sort()).toEqual(["admitted", "duplicate"]);
    expect(await client.costEvent.count()).toBe(1);
  });

  it("ignores legacy cost events and other workspaces", async () => {
    const workspaceId = await workspace();
    const other = await workspace();
    await client.costEvent.create({
      data: {
        id: "legacy",
        workspaceId,
        provider: "openai",
        operation: "image",
        estimatedMinor: 1_000_000,
        currency: "USD",
        status: "unresolved",
      },
    });
    for (const key of ["a", "b", "c"]) await reserve(other, key);
    expect((await reserve(workspaceId, "a")).status).toBe("admitted");
    expect(
      await ledger.settle({
        workspaceId: other,
        operationKey: "legacy",
        actualMinor: 1,
        receipt: "x",
      }),
    ).toBeNull();
  });

  it("keeps an unknown outcome of another budget blocking, and never releases a recorded run", async () => {
    const workspaceId = await workspace();
    await reserve(workspaceId, "last-month");
    await ledger.recordRun({ workspaceId, operationKey: "last-month", runRef: "modal:fc-1" });
    expect(await ledger.release({ workspaceId, operationKey: "last-month" })).toBeNull();
    await ledger.markUnknown({ workspaceId, operationKey: "last-month" });
    const otherBudget = await ledger.reserve({
      workspaceId,
      operationKey: "next",
      operation: "i2v_5s",
      quote,
      policy: { ...policy, key: "paid-next-month" },
      now,
    });
    expect(otherBudget).toEqual({ status: "rejected", reason: "unknown_outcome_pending" });
  });

  it("blocks after an unknown outcome until it is reconciled", async () => {
    const workspaceId = await workspace();
    await reserve(workspaceId, "lost");
    expect(await ledger.markUnknown({ workspaceId, operationKey: "lost" })).toMatchObject({
      status: "unresolved",
    });
    expect(await ledger.release({ workspaceId, operationKey: "lost" })).toBeNull();
    expect(await reserve(workspaceId, "next")).toEqual({
      status: "rejected",
      reason: "unknown_outcome_pending",
    });
    expect(
      await ledger.settle({ workspaceId, operationKey: "lost", actualMinor: 0, receipt: "bill-1" }),
    ).toMatchObject({ status: "settled", actualMinor: 0, receipt: "bill-1" });
    expect((await reserve(workspaceId, "next")).status).toBe("admitted");
  });
});
