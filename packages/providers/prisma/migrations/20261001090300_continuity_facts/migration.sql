-- Append-only story continuity facts per series (Stickman v2 slice 31). New table only.
CREATE TABLE "continuity_facts" (
  "workspace_id" UUID NOT NULL,
  "series_id" TEXT NOT NULL,
  "fact_id" TEXT NOT NULL,
  "episode_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "predicate" TEXT NOT NULL,
  "object" TEXT,
  "salience" INTEGER NOT NULL,
  "supersedes" TEXT,
  "expires_episode" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "continuity_facts_pkey" PRIMARY KEY ("workspace_id", "series_id", "fact_id"),
  CONSTRAINT "continuity_facts_kind_check" CHECK ("kind" IN ('relationship', 'job', 'location', 'possession', 'knowledge', 'event', 'gag', 'conflict', 'growth')),
  CONSTRAINT "continuity_facts_salience_check" CHECK ("salience" BETWEEN 1 AND 3),
  CONSTRAINT "continuity_facts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "continuity_facts_workspace_series_idx" ON "continuity_facts"("workspace_id", "series_id", "created_at");
