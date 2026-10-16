import type { StoryImageComposer } from "@money-maker/core/assets/story-image-composer";
import { composeSlideFrame } from "./ffmpeg-reel-renderer.js";

const outputWidth = 1080;
const outputHeight = 1920;

/** Reuses render_reel's per-frame compositing (sharp, no ffmpeg) for a single Stories image. */
export const createSharpStoryImageComposer = (): StoryImageComposer => ({
  async compose(input) {
    const bytes = await composeSlideFrame(input);
    return {
      bytes: new Uint8Array(bytes),
      mimeType: "image/jpeg",
      width: outputWidth,
      height: outputHeight,
    };
  },
});
