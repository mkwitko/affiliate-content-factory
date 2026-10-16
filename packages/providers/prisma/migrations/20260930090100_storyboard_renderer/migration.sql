ALTER TABLE "video_storyboards" ADD COLUMN "renderer" TEXT NOT NULL DEFAULT 'slideshow';

ALTER TABLE "video_storyboards"
  ADD CONSTRAINT "video_storyboards_renderer_check"
  CHECK ("renderer" IN ('slideshow', 'stickman_still'));
