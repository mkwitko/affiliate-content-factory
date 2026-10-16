ALTER TABLE "assets" ADD COLUMN "metadata" JSONB;

CREATE INDEX "assets_workspace_metadata_role_idx"
ON "assets" ("workspace_id", ("metadata"->>'role'));
