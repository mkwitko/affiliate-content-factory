-- Product candidate lifecycle for the affiliate human-link queue. Additive only.
-- Rollback: drop the added indexes, constraints and columns; legacy readers ignore them.
ALTER TABLE "product_candidates"
  ADD COLUMN "state" TEXT NOT NULL DEFAULT 'discovered',
  ADD COLUMN "offer_id" TEXT,
  ADD COLUMN "qualified_at" TIMESTAMP(3),
  ADD COLUMN "linked_at" TIMESTAMP(3),
  ADD COLUMN "qualification" JSONB,
  ADD CONSTRAINT "product_candidates_state_check" CHECK ("state" IN ('discovered', 'awaiting_affiliate_link', 'linked', 'in_production', 'consumed', 'rejected', 'expired', 'duplicate')),
  ADD CONSTRAINT "product_candidates_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "product_candidates_open_product_key" ON "product_candidates"("workspace_id", "provider_id") WHERE "state" IN ('awaiting_affiliate_link', 'linked', 'in_production');
CREATE INDEX "product_candidates_workspace_state_idx" ON "product_candidates"("workspace_id", "state");

ALTER TABLE "research_policies"
  ADD COLUMN "target_pending_links" INTEGER NOT NULL DEFAULT 5,
  ADD CONSTRAINT "research_policies_target_pending_links_check" CHECK ("target_pending_links" BETWEEN 0 AND 20);
