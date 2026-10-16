CREATE TYPE "NicheState" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "ChannelKind" AS ENUM ('INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'THREADS', 'TIKTOK_PHOTO_POST');
CREATE TYPE "ChannelStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "niches" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "editorial_voice" TEXT NOT NULL,
    "languages" TEXT[] NOT NULL,
    "monetization_hypothesis" TEXT NOT NULL,
    "state" "NicheState" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "niches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "label" TEXT NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "capabilities" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "niches_workspace_state_idx" ON "niches"("workspace_id", "state");
CREATE UNIQUE INDEX "channels_workspace_connection_kind_key" ON "channels"("workspace_id", "connection_id", "kind");
CREATE INDEX "channels_workspace_status_idx" ON "channels"("workspace_id", "status");

ALTER TABLE "niches" ADD CONSTRAINT "niches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
