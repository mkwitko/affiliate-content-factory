-- ai_clips: one generated video clip per scene. Existing rows stay valid. Generation progress
-- lives in clip_state (keyed by scene index) so the checksummed scenes never change.
ALTER TABLE "video_storyboards" DROP CONSTRAINT "video_storyboards_renderer_check";
ALTER TABLE "video_storyboards"
  ADD CONSTRAINT "video_storyboards_renderer_check"
  CHECK ("renderer" IN ('slideshow', 'stickman_still', 'stickman_motion', 'ai_clips'));
ALTER TABLE "video_storyboards" ADD COLUMN "clip_state" JSONB NOT NULL DEFAULT '{}';
