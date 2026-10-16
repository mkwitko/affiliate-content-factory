-- stickman_motion: SceneSpec scenes animated frame by frame (P1.5). Existing rows stay valid.
ALTER TABLE "video_storyboards" DROP CONSTRAINT "video_storyboards_renderer_check";
ALTER TABLE "video_storyboards"
  ADD CONSTRAINT "video_storyboards_renderer_check"
  CHECK ("renderer" IN ('slideshow', 'stickman_still', 'stickman_motion'));
