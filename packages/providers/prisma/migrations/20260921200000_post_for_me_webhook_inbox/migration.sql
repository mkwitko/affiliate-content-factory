ALTER TABLE "provider_connections"
ADD COLUMN "webhook_id" TEXT,
ADD COLUMN "webhook_secret_reference" TEXT;

CREATE TABLE "webhook_inboxes" (
    "id" UUID NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_resource_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_inboxes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_inboxes_delivery_key_key" ON "webhook_inboxes"("delivery_key");
CREATE INDEX "webhook_inboxes_workspace_connection_created_at_idx" ON "webhook_inboxes"("workspace_id", "connection_id", "created_at");

ALTER TABLE "webhook_inboxes" ADD CONSTRAINT "webhook_inboxes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_inboxes" ADD CONSTRAINT "webhook_inboxes_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
