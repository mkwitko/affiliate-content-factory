-- Episode ideas of a media channel: scored candidates, packaging variants and the hook contract
-- (Cost Curious phase 2). New table only.
CREATE TABLE "episode_ideas" (
  "id" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL,
  "niche_id" TEXT NOT NULL,
  "working_title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "score" JSONB NOT NULL,
  "packaging" JSONB,
  "packaging_checks" JSONB,
  "selected_variant_id" TEXT,
  "hook_contract" JSONB,
  "decision_note" TEXT,
  "content_item_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "episode_ideas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "episode_ideas_status_check" CHECK ("status" IN ('idea', 'packaging', 'approved', 'rejected', 'in_production', 'archived')),
  CONSTRAINT "episode_ideas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "episode_ideas_niche_id_fkey" FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "episode_ideas_workspace_niche_status_idx" ON "episode_ideas"("workspace_id", "niche_id", "status", "created_at");
