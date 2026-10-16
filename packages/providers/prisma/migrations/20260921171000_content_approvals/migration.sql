ALTER TYPE "ContentVariantState" ADD VALUE 'READY_FOR_REVIEW';
ALTER TYPE "ContentVariantState" ADD VALUE 'APPROVED';
ALTER TYPE "ContentVariantState" ADD VALUE 'REJECTED';
ALTER TYPE "ContentVariantState" ADD VALUE 'SCHEDULED';
ALTER TYPE "ContentVariantState" ADD VALUE 'PUBLISHED';
ALTER TYPE "ContentVariantState" ADD VALUE 'CANCELLED';

ALTER TABLE "content_variants" ADD COLUMN "rejection_reason" TEXT;

CREATE TABLE "content_approvals" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "variant_id" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "asset_checksums" TEXT[] NOT NULL,
    "offer_snapshot_id" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_approvals_workspace_variant_decided_idx" ON "content_approvals"("workspace_id", "variant_id", "decided_at");
ALTER TABLE "content_approvals" ADD CONSTRAINT "content_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_approvals" ADD CONSTRAINT "content_approvals_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "content_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_approvals" ADD CONSTRAINT "content_approvals_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_approvals" ADD CONSTRAINT "content_approvals_offer_snapshot_id_fkey" FOREIGN KEY ("offer_snapshot_id") REFERENCES "commercial_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
