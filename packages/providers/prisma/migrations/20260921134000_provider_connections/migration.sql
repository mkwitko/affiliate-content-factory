-- CreateEnum
CREATE TYPE "ProviderConnectionProvider" AS ENUM ('POST_FOR_ME');

-- CreateEnum
CREATE TYPE "ProviderConnectionMode" AS ENUM ('API_KEY', 'OAUTH');

-- CreateEnum
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'UNHEALTHY');

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" "ProviderConnectionProvider" NOT NULL,
    "mode" "ProviderConnectionMode" NOT NULL,
    "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "secret_reference" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_metadata" JSONB,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_workspace_provider_account_key" ON "provider_connections"("workspace_id", "provider", "account_id");
CREATE INDEX "provider_connections_workspace_status_idx" ON "provider_connections"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
