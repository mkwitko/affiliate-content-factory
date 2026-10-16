-- Persists publication policy allow-lists and evidenceMaxAgeDays as one nullable JSON column.
-- Existing rows read as "no allow-lists". Rollback: ALTER TABLE "publication_policies" DROP COLUMN "allow_lists";
ALTER TABLE "publication_policies" ADD COLUMN "allow_lists" JSONB;
