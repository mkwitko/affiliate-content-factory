ALTER TABLE "assets"
  ADD COLUMN "commercial_use" BOOLEAN,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "creator" TEXT;

CREATE TABLE "content_scripts" (
  "id" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL,
  "content_item_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "body" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "claims" JSONB NOT NULL,
  "beats" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "approved_by" UUID,
  "approved_at" TIMESTAMPTZ,
  "approved_checksum" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "content_scripts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_scripts_workspace_item_version_key" UNIQUE ("workspace_id", "content_item_id", "version"),
  CONSTRAINT "content_scripts_status_check" CHECK ("status" IN ('DRAFT', 'APPROVED')),
  CONSTRAINT "content_scripts_approval_check" CHECK (
    ("status" = 'APPROVED' AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_checksum" = "checksum") OR
    ("status" = 'DRAFT' AND "approved_by" IS NULL AND "approved_at" IS NULL AND "approved_checksum" IS NULL)
  ),
  CONSTRAINT "content_scripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "content_scripts_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE,
  CONSTRAINT "content_scripts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "content_scripts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX "content_scripts_workspace_item_idx" ON "content_scripts"("workspace_id", "content_item_id", "version");

CREATE TABLE "content_editorial_reviews" (
  "id" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL,
  "variant_id" TEXT NOT NULL,
  "publication_fingerprint" TEXT NOT NULL,
  "rights_fingerprint" TEXT NOT NULL,
  "review_policy_version" INTEGER NOT NULL,
  "checklist" JSONB NOT NULL,
  "verdict" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "reviewer_id" UUID NOT NULL,
  "decided_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "content_editorial_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_editorial_reviews_verdict_check" CHECK ("verdict" IN ('PASS', 'FAIL')),
  CONSTRAINT "content_editorial_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "content_editorial_reviews_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "content_variants"("id") ON DELETE CASCADE,
  CONSTRAINT "content_editorial_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX "content_editorial_reviews_variant_idx" ON "content_editorial_reviews"("workspace_id", "variant_id", "decided_at");
