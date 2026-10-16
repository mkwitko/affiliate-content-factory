-- Additive with defaults: older workers ignore the columns; rollback is DROP COLUMN.
CREATE TYPE "ReelVoiceMode" AS ENUM ('SCRIPT', 'NONE');
ALTER TABLE "content_variants" ADD COLUMN "voice_script" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "reel_renders" ADD COLUMN "voice_mode" "ReelVoiceMode" NOT NULL DEFAULT 'SCRIPT';
ALTER TABLE "reel_renders" ADD COLUMN "voice_id" TEXT;
ALTER TABLE "reel_renders" ADD COLUMN "duration_ms" INTEGER;
ALTER TABLE "reel_renders" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
