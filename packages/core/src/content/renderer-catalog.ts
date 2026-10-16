import type { CreativeFormat } from "./content.js";

/**
 * Which capabilities each storyboard renderer needs (spec 2026-09-30 generative scene clips,
 * 4.6). The worker derives its detected capabilities from the same names, so a job is claimed
 * only by a worker that can run it; the format director reads `status` so it never recommends an
 * experimental renderer the niche did not opt in to.
 */
export type RendererCapability = "ffmpeg" | "tts" | "scene_clips";
export type RendererId =
  | "slideshow"
  | "stickman_still"
  | "stickman_motion"
  | "ai_clips"
  | "hyperframes";
export type RendererInfo = Readonly<{
  needs: readonly RendererCapability[];
  cost: "free" | "free_tier";
  status: "production" | "trial";
}>;

export const RENDERERS: Readonly<Record<RendererId, RendererInfo>> = Object.freeze({
  slideshow: { needs: ["ffmpeg", "tts"], cost: "free", status: "production" },
  stickman_still: { needs: ["ffmpeg", "tts"], cost: "free", status: "production" },
  stickman_motion: { needs: ["ffmpeg", "tts"], cost: "free", status: "production" },
  ai_clips: { needs: ["ffmpeg", "tts", "scene_clips"], cost: "free_tier", status: "trial" },
  // Experimental A/B only (docs/experiments/hyperframes-spike.md): no format maps to it.
  hyperframes: { needs: ["ffmpeg", "tts"], cost: "free", status: "trial" },
});

/** Formats that are produced by one specific renderer; every other format has none to gate. */
export const RENDERER_BY_FORMAT: Readonly<Partial<Record<CreativeFormat, RendererId>>> =
  Object.freeze({ ai_story: "ai_clips" });

export const isRendererRecommendable = (
  renderer: RendererId,
  options: Readonly<{ allowTrial: boolean }>,
): boolean => RENDERERS[renderer].status === "production" || options.allowTrial;
