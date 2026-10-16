-- CreateEnum
CREATE TYPE "OfferMarketplace" AS ENUM ('MERCADO_LIVRE');

-- CreateEnum
CREATE TYPE "OfferState" AS ENUM ('DRAFT', 'ACTIVE', 'REJECTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "marketplace" "OfferMarketplace" NOT NULL,
    "listing_url" TEXT NOT NULL,
    "affiliate_url" TEXT,
    "title" TEXT NOT NULL,
    "list_price_minor" INTEGER,
    "list_price_currency" TEXT,
    "current_price_minor" INTEGER,
    "current_price_currency" TEXT,
    "discount_minor" INTEGER,
    "discount_currency" TEXT,
    "shipping_minor" INTEGER,
    "shipping_currency" TEXT,
    "commission_minor" INTEGER,
    "commission_currency" TEXT,
    "fees_minor" INTEGER,
    "fees_currency" TEXT,
    "revenue_minor" INTEGER,
    "revenue_currency" TEXT,
    "state" "OfferState" NOT NULL DEFAULT 'DRAFT',
    "active_snapshot_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commercial_snapshots" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commercial_facts" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source_url" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,

    CONSTRAINT "commercial_facts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "offers_workspace_state_idx" ON "offers"("workspace_id", "state");
CREATE UNIQUE INDEX "commercial_snapshots_offer_id_id_key" ON "commercial_snapshots"("offer_id", "id");
CREATE INDEX "commercial_snapshots_workspace_verified_at_idx" ON "commercial_snapshots"("workspace_id", "verified_at");
CREATE UNIQUE INDEX "commercial_facts_snapshot_id_key_key" ON "commercial_facts"("snapshot_id", "key");

ALTER TABLE "offers" ADD CONSTRAINT "offers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commercial_snapshots" ADD CONSTRAINT "commercial_snapshots_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commercial_snapshots" ADD CONSTRAINT "commercial_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commercial_facts" ADD CONSTRAINT "commercial_facts_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "commercial_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
