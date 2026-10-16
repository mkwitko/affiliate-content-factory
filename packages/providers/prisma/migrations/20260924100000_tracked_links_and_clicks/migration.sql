-- Niche bio link handle: nullable and backfilled, so existing niches get one without a rewrite.
ALTER TABLE "niches" ADD COLUMN "slug" TEXT;
UPDATE "niches"
SET "slug" = trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g')))
  || '-' || substr(md5("id"), 1, 8)
WHERE "slug" IS NULL;
CREATE UNIQUE INDEX "niches_slug_key" ON "niches"("slug");

CREATE TABLE "tracked_links" (
    "slug" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_variant_id" TEXT,
    "offer_id" TEXT,
    "destination" TEXT NOT NULL,
    "destination_fingerprint" TEXT NOT NULL,
    "fallback_url" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("slug")
);
CREATE INDEX "tracked_links_workspace_variant_idx" ON "tracked_links"("workspace_id", "content_variant_id");
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "click_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "slug" TEXT,
    "content_variant_id" TEXT,
    "via" TEXT NOT NULL,
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "visitor_hash" TEXT NOT NULL,
    "referrer_host" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "click_events_workspace_occurred_idx" ON "click_events"("workspace_id", "occurred_at");
CREATE INDEX "click_events_workspace_variant_idx" ON "click_events"("workspace_id", "content_variant_id");
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
