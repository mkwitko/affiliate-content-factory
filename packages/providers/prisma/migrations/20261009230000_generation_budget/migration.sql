-- Paid-generation budget ledger (cloud GPU pilot P1). Additive and nullable: legacy rows keep
-- budget_key NULL and never count toward a budget. Rollback: drop the index and the columns.
ALTER TABLE "cost_events" ADD COLUMN "budget_key" TEXT,
ADD COLUMN "operation_key" TEXT,
ADD COLUMN "expires_at" TIMESTAMP(3),
ADD COLUMN "receipt" TEXT,
ADD COLUMN "quote" JSONB;

CREATE UNIQUE INDEX "cost_events_workspace_operation_key" ON "cost_events"("workspace_id", "operation_key");
CREATE INDEX "cost_events_workspace_budget_idx" ON "cost_events"("workspace_id", "budget_key");
