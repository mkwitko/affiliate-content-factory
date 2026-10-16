CREATE TYPE "ContentItemState" AS ENUM ('DRAFT');
CREATE TYPE "ContentVariantState" AS ENUM ('DRAFT');

CREATE TABLE "content_items" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "niche_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "offer_snapshot_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_fact_keys" TEXT[] NOT NULL,
    "creative_opinion" TEXT NOT NULL,
    "state" "ContentItemState" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_variants" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "offer_snapshot_id" TEXT NOT NULL,
    "asset_ids" TEXT[] NOT NULL,
    "caption" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "state" "ContentVariantState" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "content_variants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_items_workspace_state_idx" ON "content_items"("workspace_id", "state");
CREATE INDEX "content_variants_workspace_state_idx" ON "content_variants"("workspace_id", "state");

ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_niche_id_fkey" FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_offer_snapshot_id_fkey" FOREIGN KEY ("offer_snapshot_id") REFERENCES "commercial_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_offer_snapshot_id_fkey" FOREIGN KEY ("offer_snapshot_id") REFERENCES "commercial_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
