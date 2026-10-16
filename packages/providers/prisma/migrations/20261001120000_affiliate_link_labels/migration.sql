-- Records an already-assigned Mercado Livre label as reporting metadata.
-- The application never creates or deletes marketplace labels.
ALTER TABLE "tracked_links"
ADD COLUMN "marketplace_label" TEXT;

-- Rollback on a disposable database only:
-- ALTER TABLE "tracked_links" DROP COLUMN "marketplace_label";
