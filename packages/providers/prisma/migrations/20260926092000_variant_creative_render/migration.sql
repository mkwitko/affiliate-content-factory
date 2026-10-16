ALTER TABLE "content_items"
ADD COLUMN "source_picture_asset_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "content_items"
ADD COLUMN "creative_slides" JSONB;

ALTER TABLE "content_variants"
ADD COLUMN "creative_render" JSONB;
