ALTER TABLE "publication_attempts" ADD COLUMN "scheduled_at" TIMESTAMP(3);
ALTER TABLE "publication_attempts" ADD COLUMN "published_at" TIMESTAMP(3);
-- Existing published attempts: their last update is the closest known publication time.
UPDATE "publication_attempts" SET "published_at" = "updated_at" WHERE "status" = 'PUBLISHED';
