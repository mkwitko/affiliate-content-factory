ALTER TYPE "ChannelKind" ADD VALUE IF NOT EXISTS 'INSTAGRAM_REELS';

CREATE TYPE "ReelRenderStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "reel_renders" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_variant_id" TEXT NOT NULL,
    "status" "ReelRenderStatus" NOT NULL DEFAULT 'PENDING',
    "asset_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_renders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reel_renders_workspace_source_variant_key" ON "reel_renders"("workspace_id", "source_variant_id");

ALTER TABLE "reel_renders" ADD CONSTRAINT "reel_renders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reel_renders" ADD CONSTRAINT "reel_renders_source_variant_id_fkey" FOREIGN KEY ("source_variant_id") REFERENCES "content_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
