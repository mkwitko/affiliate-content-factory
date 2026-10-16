ALTER TABLE "content_items"
  ALTER COLUMN "offer_id" DROP NOT NULL,
  ALTER COLUMN "offer_snapshot_id" DROP NOT NULL;
ALTER TABLE "content_variants"
  ALTER COLUMN "offer_snapshot_id" DROP NOT NULL;
ALTER TABLE "content_approvals"
  ALTER COLUMN "offer_snapshot_id" DROP NOT NULL;

ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_offer_pair_check"
    CHECK (("offer_id" IS NULL) = ("offer_snapshot_id" IS NULL)),
  ADD CONSTRAINT "content_items_facts_require_offer_check"
    CHECK ("offer_id" IS NOT NULL OR cardinality("source_fact_keys") = 0);
