ALTER TABLE "content_performance"
  ADD COLUMN "estimated_minutes_watched" INTEGER,
  ADD COLUMN "average_view_duration_seconds" INTEGER,
  ADD COLUMN "average_view_percentage" NUMERIC(6,2),
  ADD COLUMN "subscribers_gained" INTEGER,
  ADD COLUMN "subscribers_lost" INTEGER,
  ADD COLUMN "engaged_views" INTEGER;
