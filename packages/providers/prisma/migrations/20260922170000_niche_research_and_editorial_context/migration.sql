-- Research snapshots gain a source niche and two new evidence sources.
ALTER TYPE "ResearchProvider" ADD VALUE 'MERCADO_LIVRE';
ALTER TYPE "ResearchProvider" ADD VALUE 'MANUAL';

ALTER TABLE "research_snapshots" ADD COLUMN "niche_id" TEXT;
ALTER TABLE "research_snapshots" ADD CONSTRAINT "research_snapshots_niche_id_fkey"
  FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "research_snapshots_workspace_niche_idx" ON "research_snapshots"("workspace_id", "niche_id");

-- Layered editorial context: Brand (workspace) -> Niche -> Channel. All nullable, additive.
ALTER TABLE "workspaces" ADD COLUMN "context" JSONB;
ALTER TABLE "niches" ADD COLUMN "context" JSONB;
ALTER TABLE "channels" ADD COLUMN "context" JSONB;
