import { parseWorkspaceId } from "@money-maker/contracts";
import {
  CLOUD_GPU_PILOT_BUDGET,
  createInMemoryGenerationBudgetLedger,
} from "@money-maker/core/costs/generation-budget";
import { freeCreditPolicy } from "@money-maker/core/costs/generation-settings";
import { describe, expect, it } from "vitest";
import { runCloudBudget } from "./cloud-budget.js";

const now = new Date("2026-10-15T12:00:00Z");
const ws = "0d7702aa-a69d-4f49-842a-c1a13e72160d";
const workspaceId = parseWorkspaceId(ws);

const seeded = async () => {
  const ledger = createInMemoryGenerationBudgetLedger();
  const reserve = (operationKey: string) =>
    ledger.reserve({
      workspaceId,
      operationKey,
      operation: "scene_clip:i2v_5s",
      quote: {
        provider: "modal",
        model: "m",
        revision: "r",
        sourceCurrency: "BRL",
        sourceMinor: 426,
        taxMarginBps: 0,
        quotedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      policy: { ...CLOUD_GPU_PILOT_BUDGET, providers: ["modal"] },
      now,
    });
  await reserve("lost");
  await reserve("never-sent");
  await ledger.recordRun({ workspaceId, operationKey: "lost", runRef: "modal:fc-1" });
  await ledger.markUnknown({ workspaceId, operationKey: "lost" });
  return ledger;
};

describe("cloud-budget", () => {
  it("defaults to this month's paid budget and still finds a recorded free-credit run on release", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const free = freeCreditPolicy("modal", { amountMinor: 3_000, currency: "USD" }, now);
    await ledger.reserve({
      workspaceId,
      operationKey: "free-run",
      operation: "scene_clip:i2v_5s",
      quote: {
        provider: "modal",
        model: "m",
        revision: "r",
        sourceCurrency: "USD",
        sourceMinor: 80,
        taxMarginBps: 0,
        quotedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      policy: free,
      now,
    });
    await ledger.recordRun({ workspaceId, operationKey: "free-run", runRef: "modal:fc-9" });
    expect(await runCloudBudget(ledger, ["status", "--workspace", ws], now)).toContain(
      "Budget paid-2026-10",
    );
    await expect(
      runCloudBudget(ledger, ["release", "--workspace", ws, "--operation", "free-run"], now),
    ).rejects.toThrow("cloud_budget_run_recorded_use_reconcile");
  });

  it("shows the block, then reconciles the unknown run with the provider's real charge", async () => {
    const ledger = await seeded();
    const status = await runCloudBudget(
      ledger,
      ["status", "--workspace", ws, "--budget", CLOUD_GPU_PILOT_BUDGET.key],
      now,
    );
    expect(status).toContain("unknown R$ 4.26");
    expect(status).toContain("BLOCKED");
    expect(status).toContain(
      "lost | modal | unresolved | estimate R$ 4.26 | actual - | modal:fc-1",
    );
    expect(
      await runCloudBudget(ledger, [
        "reconcile",
        "--workspace",
        ws,
        "--operation",
        "lost",
        "--actual-centavos",
        "37",
        "--receipt",
        "modal-invoice-2026-10",
      ]),
    ).toBe("settled lost: R$ 0.37 (modal-invoice-2026-10)");
    expect(
      await runCloudBudget(
        ledger,
        ["status", "--workspace", ws, "--budget", CLOUD_GPU_PILOT_BUDGET.key],
        now,
      ),
    ).toContain("No unknown outcome.");
  });

  it("releases only a reservation that never reached the provider", async () => {
    const ledger = await seeded();
    await expect(
      runCloudBudget(ledger, [
        "release",
        "--workspace",
        ws,
        "--operation",
        "lost",
        "--budget",
        CLOUD_GPU_PILOT_BUDGET.key,
      ]),
    ).rejects.toThrow("cloud_budget_run_recorded_use_reconcile");
    expect(
      await runCloudBudget(ledger, ["release", "--workspace", ws, "--operation", "never-sent"]),
    ).toBe("released never-sent");
  });

  it("refuses a negative or fractional charge and a missing flag", async () => {
    const ledger = await seeded();
    for (const value of ["-1", "1.5", "abc"])
      await expect(
        runCloudBudget(ledger, [
          "reconcile",
          "--workspace",
          ws,
          "--operation",
          "lost",
          "--actual-centavos",
          value,
          "--receipt",
          "x",
        ]),
      ).rejects.toThrow("cloud_budget_actual_invalid");
    await expect(
      runCloudBudget(ledger, ["reconcile", "--workspace", ws, "--operation", "lost"]),
    ).rejects.toThrow("cloud_budget_flag_missing:actual-centavos");
  });
});
