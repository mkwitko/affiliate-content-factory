import { describe, expect, it } from "vitest";
import { isRendererRecommendable, RENDERER_BY_FORMAT, RENDERERS } from "./renderer-catalog.js";

describe("renderer catalog", () => {
  it("lists every storyboard renderer with the capabilities it needs", () => {
    expect(Object.keys(RENDERERS).sort()).toEqual([
      "ai_clips",
      "hyperframes",
      "slideshow",
      "stickman_motion",
      "stickman_still",
    ]);
    for (const id of ["slideshow", "stickman_still", "stickman_motion"] as const)
      expect(RENDERERS[id]).toEqual({
        needs: ["ffmpeg", "tts"],
        cost: "free",
        status: "production",
      });
    expect(RENDERERS.ai_clips).toEqual({
      needs: ["ffmpeg", "tts", "scene_clips"],
      cost: "free_tier",
      status: "trial",
    });
  });
  it("keeps hyperframes a trial renderer that no format or production default selects", () => {
    expect(RENDERERS.hyperframes.status).toBe("trial");
    expect(Object.values(RENDERER_BY_FORMAT)).not.toContain("hyperframes");
    expect(isRendererRecommendable("hyperframes", { allowTrial: false })).toBe(false);
    expect(isRendererRecommendable("hyperframes", { allowTrial: true })).toBe(true);
    expect(RENDERERS.stickman_motion.status).toBe("production");
  });
  it("only ai_story maps to a renderer, and it is the trial one", () => {
    expect(RENDERER_BY_FORMAT).toEqual({ ai_story: "ai_clips" });
  });
  it("recommends a trial renderer only when the niche opted in", () => {
    expect(isRendererRecommendable("slideshow", { allowTrial: false })).toBe(true);
    expect(isRendererRecommendable("ai_clips", { allowTrial: false })).toBe(false);
    expect(isRendererRecommendable("ai_clips", { allowTrial: true })).toBe(true);
  });
});
