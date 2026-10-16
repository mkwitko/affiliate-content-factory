-- Home worker tokens for the task API (ADR 0012, closes D4). New table only.
CREATE TABLE "home_worker_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "capabilities" TEXT[],
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "home_worker_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "home_worker_tokens_token_hash_key" ON "home_worker_tokens"("token_hash");

CREATE INDEX "home_worker_tokens_workspace_id_idx" ON "home_worker_tokens"("workspace_id");

ALTER TABLE "home_worker_tokens" ADD CONSTRAINT "home_worker_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
