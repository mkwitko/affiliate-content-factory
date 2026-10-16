ALTER TABLE "content_items"
  ADD COLUMN "source_content_item_id" TEXT,
  ADD CONSTRAINT "content_items_source_not_self_check"
    CHECK ("source_content_item_id" IS NULL OR "source_content_item_id" <> "id");

CREATE UNIQUE INDEX "content_items_workspace_id_id_key"
  ON "content_items"("workspace_id", "id");

CREATE INDEX "content_items_workspace_source_idx"
  ON "content_items"("workspace_id", "source_content_item_id");

ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_source_workspace_fkey"
    FOREIGN KEY ("workspace_id", "source_content_item_id")
    REFERENCES "content_items"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
