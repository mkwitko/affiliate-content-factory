-- Nullable and additive: older workers ignore it; rollback is DROP COLUMN.
ALTER TABLE "reel_renders" ADD COLUMN "music_track_id" TEXT;
