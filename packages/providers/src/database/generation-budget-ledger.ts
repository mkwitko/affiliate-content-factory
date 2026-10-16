import { parseWorkspaceId } from "@money-maker/contracts";
import {
  admissionEntries,
  admitGenerationSpend,
  assertMinor,
  type BudgetAction,
  type BudgetReservation,
  type BudgetStatus,
  type GenerationBudgetLedger,
  nextBudgetStatus,
} from "@money-maker/core/costs/generation-budget";
import type { DatabaseClient } from "./client.js";

type Row = Readonly<{
  id: string;
  workspaceId: string;
  operationKey: string | null;
  budgetKey: string | null;
  provider: string;
  operation: string;
  estimatedMinor: number;
  actualMinor: number | null;
  currency: string;
  status: string;
  expiresAt: Date | null;
  receipt: string | null;
}>;

const STATUSES: readonly string[] = ["reserved", "settled", "unresolved", "released"];
const toReservation = (row: Row): BudgetReservation => {
  if (!row.operationKey || !row.budgetKey || !row.expiresAt || !STATUSES.includes(row.status))
    throw new Error("budget_row_invalid");
  return {
    id: row.id,
    workspaceId: parseWorkspaceId(row.workspaceId),
    operationKey: row.operationKey,
    budgetKey: row.budgetKey,
    provider: row.provider,
    operation: row.operation,
    estimatedMinor: row.estimatedMinor,
    ...(row.actualMinor === null ? {} : { actualMinor: row.actualMinor }),
    currency: row.currency,
    status: row.status as BudgetStatus,
    expiresAt: row.expiresAt,
    ...(row.receipt === null ? {} : { receipt: row.receipt }),
  };
};

/**
 * Budget reservations in cost_events. Each reserve takes a transaction-scoped advisory lock on
 * (workspace, budget key), so concurrent admissions for one budget run one at a time; the unique
 * (workspace_id, operation_key) index is the backstop against a double reservation.
 */
export class PrismaGenerationBudgetLedger implements GenerationBudgetLedger {
  public constructor(private readonly client: DatabaseClient) {}

  public reserve: GenerationBudgetLedger["reserve"] = (input) =>
    this.client.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}), hashtext(${input.policy.key}))`;
      const existing = await transaction.costEvent.findUnique({
        where: {
          workspaceId_operationKey: {
            workspaceId: input.workspaceId,
            operationKey: input.operationKey,
          },
        },
      });
      if (existing) return { status: "duplicate", reservation: toReservation(existing) };
      // This budget's rows plus every open row of the provider in other budgets: an unknown
      // outcome from last month or from a free credit keeps blocking (admissionEntries).
      const rows = await transaction.costEvent.findMany({
        where: {
          workspaceId: input.workspaceId,
          budgetKey: { not: null },
          OR: [
            { budgetKey: input.policy.key },
            { provider: input.quote.provider, status: { in: ["reserved", "unresolved"] } },
          ],
        },
      });
      const admission = admitGenerationSpend({
        policy: input.policy,
        quote: input.quote,
        now: input.now,
        entries: admissionEntries(
          rows.map((row) => toReservation(row)),
          input,
        ),
      });
      if (!admission.admitted) return { status: "rejected", reason: admission.reason };
      const created = await transaction.costEvent.create({
        data: {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          provider: input.quote.provider,
          operation: input.operation,
          estimatedMinor: admission.reserveMinor,
          currency: input.policy.currency ?? "BRL",
          status: "reserved",
          budgetKey: input.policy.key,
          operationKey: input.operationKey,
          expiresAt: admission.expiresAt,
          quote: JSON.parse(JSON.stringify(input.quote)),
        },
      });
      return { status: "admitted", reservation: toReservation(created) };
    });

  public settle: GenerationBudgetLedger["settle"] = async (input) => {
    assertMinor(input.actualMinor);
    return this.move(input, "settle", { actualMinor: input.actualMinor, receipt: input.receipt });
  };

  public markUnknown: GenerationBudgetLedger["markUnknown"] = (input) =>
    this.move(input, "mark_unknown");

  // A reservation with a recorded run may have been billed: reconcile it, never release it.
  public release: GenerationBudgetLedger["release"] = (input) =>
    this.move(input, "release", {}, { receipt: null });

  public recordRun: GenerationBudgetLedger["recordRun"] = async (input) => {
    const updated = await this.client.costEvent.updateMany({
      where: {
        workspaceId: input.workspaceId,
        operationKey: input.operationKey,
        budgetKey: { not: null },
        status: { in: ["reserved", "unresolved"] },
      },
      data: { receipt: input.runRef },
    });
    if (updated.count === 0) return null;
    const row = await this.client.costEvent.findFirst({
      where: { workspaceId: input.workspaceId, operationKey: input.operationKey },
    });
    return row ? toReservation(row) : null;
  };

  public list: GenerationBudgetLedger["list"] = async (input) =>
    (
      await this.client.costEvent.findMany({
        where: { workspaceId: input.workspaceId, budgetKey: input.budgetKey },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => toReservation(row));

  private async move(
    key: Readonly<{ workspaceId: string; operationKey: string }>,
    action: BudgetAction,
    patch: Readonly<{ actualMinor?: number; receipt?: string }> = {},
    guard: Readonly<{ receipt?: null }> = {},
  ): Promise<BudgetReservation | null> {
    const row = await this.client.costEvent.findFirst({
      where: {
        workspaceId: key.workspaceId,
        operationKey: key.operationKey,
        budgetKey: { not: null },
      },
    });
    if (guard.receipt === null && row?.receipt) return null;
    const status = row && nextBudgetStatus(row.status as BudgetStatus, action);
    if (!row || !status) return null;
    if (row.status === status && action !== "mark_unknown") return toReservation(row);
    // Compare-and-set on the status read above; a concurrent move wins and this one re-reads.
    const updated = await this.client.costEvent.updateMany({
      where: { id: row.id, status: row.status, ...guard },
      data: { ...patch, status },
    });
    if (updated.count === 0) return this.move(key, action, patch, guard);
    return toReservation({ ...row, ...patch, status });
  }
}
