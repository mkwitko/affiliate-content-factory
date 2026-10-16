-- Generation orchestrator C1 (2026-10-14). Additive: two new tables.
-- Rollback: DROP TABLE "generation_runs"; DROP TABLE "generation_routes";
CREATE TABLE "generation_routes" (
    "workspace_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "executor" TEXT NOT NULL,
    "cost" TEXT NOT NULL,
    "provider" TEXT,
    "state" TEXT NOT NULL,
    "owner_rank" INTEGER,
    "cost_per_unit_minor" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "generation_routes_pkey" PRIMARY KEY ("workspace_id", "id")
);

CREATE TABLE "generation_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "route_id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "retry_after" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "generation_runs_route_idx" ON "generation_runs"("workspace_id", "route_id", "created_at");

ALTER TABLE "generation_routes" ADD CONSTRAINT "generation_routes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
