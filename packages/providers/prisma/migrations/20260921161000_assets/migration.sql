CREATE TYPE "AssetState" AS ENUM ('PENDING', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "provenance" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "state" "AssetState" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assets_workspace_state_idx" ON "assets"("workspace_id", "state");
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
