CREATE TABLE "secret_records" (
    "reference" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "workspace_id" UUID NOT NULL,
    CONSTRAINT "secret_records_pkey" PRIMARY KEY ("reference")
);
CREATE INDEX "secret_records_workspace_idx" ON "secret_records"("workspace_id");
ALTER TABLE "secret_records" ADD CONSTRAINT "secret_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
