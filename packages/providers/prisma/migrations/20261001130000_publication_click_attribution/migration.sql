-- Keep variant-level attribution while recording the exact publication attempt for outbound clicks.
ALTER TABLE "tracked_links"
ADD COLUMN "publication_attempt_id" TEXT;

CREATE UNIQUE INDEX "tracked_links_workspace_publication_key"
ON "tracked_links"("workspace_id", "publication_attempt_id");

ALTER TABLE "click_events"
ADD COLUMN "publication_attempt_id" TEXT;

CREATE INDEX "click_events_workspace_publication_idx"
ON "click_events"("workspace_id", "publication_attempt_id");

-- Rollback on a disposable database only:
-- DROP INDEX "click_events_workspace_publication_idx";
-- ALTER TABLE "click_events" DROP COLUMN "publication_attempt_id";
-- DROP INDEX "tracked_links_workspace_publication_key";
-- ALTER TABLE "tracked_links" DROP COLUMN "publication_attempt_id";
