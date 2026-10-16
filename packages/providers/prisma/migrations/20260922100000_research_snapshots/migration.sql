CREATE TYPE "ResearchProvider" AS ENUM ('VIDIQ', 'HOOK_LAYER');

CREATE TABLE "research_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" "ResearchProvider" NOT NULL,
    "query" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "content_hash" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "research_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "research_snapshots_workspace_hash_key" ON "research_snapshots"("workspace_id", "content_hash");
CREATE INDEX "research_snapshots_workspace_observed_idx" ON "research_snapshots"("workspace_id", "observed_at");
ALTER TABLE "research_snapshots" ADD CONSTRAINT "research_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_snapshots" ADD CONSTRAINT "research_snapshots_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "research_observations" (
    "id" UUID NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    CONSTRAINT "research_observations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "research_observations_snapshot_key_url_key" ON "research_observations"("snapshot_id", "key", "source_url");
CREATE INDEX "research_observations_snapshot_idx" ON "research_observations"("snapshot_id");
ALTER TABLE "research_observations" ADD CONSTRAINT "research_observations_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "research_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
