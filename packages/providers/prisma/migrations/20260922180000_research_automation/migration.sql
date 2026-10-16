-- Bounded, per-niche Mercado Livre research automation: a policy that says when/how to
-- search, and the product candidates a run stores for a human to review. Additive only.
CREATE TYPE "ResearchPolicyFrequency" AS ENUM ('DAILY', 'WEEKLY');
CREATE TYPE "ResearchPolicyStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED');

CREATE TABLE "research_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "niche_id" TEXT NOT NULL,
    "frequency" "ResearchPolicyFrequency" NOT NULL,
    "max_candidates_per_run" INTEGER NOT NULL,
    "price_min_minor" INTEGER,
    "price_max_minor" INTEGER,
    "currency" TEXT,
    "explicit_queries" TEXT[] NOT NULL,
    "status" "ResearchPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "research_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_candidates" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "niche_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "listing_url" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "discovered_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_policies_workspace_niche_key" ON "research_policies"("workspace_id", "niche_id");
CREATE INDEX "research_policies_status_frequency_idx" ON "research_policies"("status", "frequency");
CREATE INDEX "product_candidates_workspace_niche_discovered_idx" ON "product_candidates"("workspace_id", "niche_id", "discovered_at");

ALTER TABLE "research_policies" ADD CONSTRAINT "research_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_policies" ADD CONSTRAINT "research_policies_niche_id_fkey" FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_candidates" ADD CONSTRAINT "product_candidates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_candidates" ADD CONSTRAINT "product_candidates_niche_id_fkey" FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_candidates" ADD CONSTRAINT "product_candidates_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "research_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
