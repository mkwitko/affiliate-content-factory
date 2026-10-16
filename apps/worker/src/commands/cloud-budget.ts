import { pathToFileURL } from "node:url";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  type BudgetReservation,
  type GenerationBudgetLedger,
  spendSummary,
} from "@money-maker/core/costs/generation-budget";
import {
  CLOUD_PROVIDERS,
  DEFAULT_GENERATION_SETTINGS,
  paidBudgetPolicy,
  saoPauloMonth,
} from "@money-maker/core/costs/generation-settings";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaGenerationBudgetLedger } from "@money-maker/providers/database/generation-budget-ledger";

/**
 * Owner tool for the paid-generation budget (cloud GPU pilot):
 *
 *   cloud-budget status    --workspace <id> [--budget paid-2026-10|free-modal-2026-10]
 *   cloud-budget reconcile --workspace <id> --operation <key> --actual-centavos <n> --receipt <text>
 *   cloud-budget release   --workspace <id> --operation <key> [--budget <key>]
 *
 * `--budget` defaults to this São Paulo month's paid budget. The cap shown is the default
 * (R$100); the owner's own cap and free credit are read with the get_generation_budget MCP tool.
 *
 * `reconcile` records what the provider really charged for a run (0 when nothing was billed);
 * it is the only way to clear an unknown outcome, which blocks every new paid run. `release`
 * frees a reservation that never reached the provider; it refuses one with a recorded run.
 */
const brl = (minor: number) => `R$ ${(minor / 100).toFixed(2)}`;

export const runCloudBudget = async (
  ledger: GenerationBudgetLedger,
  argv: readonly string[],
  now: Date = new Date(),
): Promise<string> => {
  const [command] = argv;
  const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`cloud_budget_flag_missing:${name}`);
    return value;
  };
  const workspaceId = parseWorkspaceId(flag("workspace"));
  const budgetIndex = argv.indexOf("--budget");
  const budgetKey = argv[budgetIndex + 1];
  const policy = {
    ...paidBudgetPolicy(DEFAULT_GENERATION_SETTINGS, [], now),
    ...(budgetIndex >= 0 && budgetKey && !budgetKey.startsWith("--") ? { key: budgetKey } : {}),
  };
  if (command === "status") {
    const rows = await ledger.list({ workspaceId, budgetKey: policy.key });
    const summary = spendSummary(rows, policy, now);
    // A free credit is counted in US cents and its cap is the owner's (get_generation_budget).
    const free = policy.key.startsWith("free-");
    const money = (minor: number) => (free ? `US$ ${(minor / 100).toFixed(2)}` : brl(minor));
    const line = (row: BudgetReservation) =>
      [
        row.operationKey,
        row.provider,
        row.status === "reserved" && row.expiresAt.getTime() <= now.getTime()
          ? "reserved(expired: reconcile)"
          : row.status,
        `estimate ${money(row.estimatedMinor)}`,
        row.actualMinor === undefined ? "actual -" : `actual ${money(row.actualMinor)}`,
        row.receipt ?? "-",
      ].join(" | ");
    return [
      free
        ? `Budget ${policy.key}: free credit (cap: get_generation_budget)`
        : `Budget ${policy.key}: default cap ${brl(policy.capMinor)}`,
      `settled ${money(summary.settledMinor)} | reserved ${money(summary.reservedMinor)} | unknown ${money(summary.unknownMinor)}${free ? "" : ` | remaining ${brl(summary.remainingMinor)}`}`,
      summary.unknownMinor > 0
        ? "BLOCKED: unknown outcomes hold every new paid run until reconciled."
        : "No unknown outcome.",
      ...rows.map(line),
    ].join("\n");
  }
  const operationKey = flag("operation");
  if (command === "reconcile") {
    const actual = Number(flag("actual-centavos"));
    const receipt = flag("receipt");
    if (!Number.isSafeInteger(actual) || actual < 0) throw new Error("cloud_budget_actual_invalid");
    const settled = await ledger.settle({
      workspaceId,
      operationKey,
      actualMinor: actual,
      receipt,
    });
    if (!settled) throw new Error("cloud_budget_reservation_not_open");
    return `settled ${operationKey}: ${brl(settled.actualMinor ?? actual)} (${settled.receipt})`;
  }
  if (command === "release") {
    // Search every budget of the month unless one is named, so a forgotten --budget never skips
    // the recorded-run check.
    const month = saoPauloMonth(now).label;
    const keys =
      budgetIndex >= 0
        ? [policy.key]
        : [policy.key, ...CLOUD_PROVIDERS.map((provider) => `free-${provider}-${month}`)];
    const rows = (
      await Promise.all(keys.map((key) => ledger.list({ workspaceId, budgetKey: key })))
    ).flat();
    const row = rows.find((candidate) => candidate.operationKey === operationKey);
    if (row?.receipt) throw new Error("cloud_budget_run_recorded_use_reconcile");
    const released = await ledger.release({ workspaceId, operationKey });
    if (!released) throw new Error("cloud_budget_reservation_not_releasable");
    return `released ${operationKey}`;
  }
  throw new Error("cloud_budget_command_unknown");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const client = createDatabaseClient(url);
  try {
    console.log(
      await runCloudBudget(new PrismaGenerationBudgetLedger(client), process.argv.slice(2)),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "cloud_budget_failed");
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}
