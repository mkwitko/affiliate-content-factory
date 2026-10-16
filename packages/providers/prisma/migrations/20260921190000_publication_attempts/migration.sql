CREATE TYPE "PublicationStatus" AS ENUM ('QUEUED', 'PUBLISHING', 'PUBLISHED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'UNKNOWN_OUTCOME', 'CANCELLED');

CREATE TABLE "publication_attempts" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_variant_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'QUEUED',
    "external_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT NOT NULL,
    "terminal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publication_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publication_attempts_workspace_id_idempotency_key" ON "publication_attempts"("workspace_id", "idempotency_key");
CREATE INDEX "publication_attempts_workspace_status_idx" ON "publication_attempts"("workspace_id", "status");
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_content_variant_id_fkey" FOREIGN KEY ("content_variant_id") REFERENCES "content_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
