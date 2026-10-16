ALTER TYPE "OfferMarketplace" ADD VALUE IF NOT EXISTS 'TIKTOK_SHOP';

ALTER TYPE "ChannelKind" ADD VALUE IF NOT EXISTS 'TIKTOK_VIDEO';

ALTER TABLE "offers" ADD COLUMN "external_product_id" TEXT;

-- Partial index: only enforced when an offer names an external marketplace product id
-- (TikTok Shop today). Documented in schema.prisma as SQL-only, like other partial indexes.
CREATE UNIQUE INDEX "offers_workspace_marketplace_product_key"
  ON "offers"("workspace_id", "marketplace", "external_product_id")
  WHERE "external_product_id" IS NOT NULL;
