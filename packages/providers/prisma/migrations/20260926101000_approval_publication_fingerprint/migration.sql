ALTER TABLE "content_approvals"
  ADD COLUMN "publication_fingerprint" TEXT;

CREATE INDEX "content_approvals_fingerprint_idx"
  ON "content_approvals" ("workspace_id", "publication_fingerprint");
