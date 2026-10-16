import { estimateNarrationSeconds } from "../explainer/script-guards.js";

/**
 * Server-chosen generation profile for local image-to-video clips (spec 2026-10-02, decision 7).
 * The home machine never picks size, frames or steps: the task carries this profile and the
 * result is checked against it.
 */
export const LOCAL_CLIP_FRAMES = [17, 25, 33] as const;
export const LOCAL_CLIP_FPS = 16;
export const LOCAL_CLIP_MAX_STEPS = 20;
const SIZES = {
  landscape: { width: 832, height: 480 },
  portrait: { width: 480, height: 832 },
} as const;

export type LocalClipProfile = Readonly<{
  frames: (typeof LOCAL_CLIP_FRAMES)[number];
  fps: typeof LOCAL_CLIP_FPS;
  width: number;
  height: number;
  steps: number;
}>;

/** Scene length the clip must cover: narration estimate, 4-12 s (same bounds as hosted clips). */
export const clipSeconds = (narration: string, language: string): number =>
  Math.min(12, Math.max(4, Math.ceil(estimateNarrationSeconds(narration, language))));

/** Frames cover the scene up to the 33-frame cap (and `maxFrames`); null when no profile fits. */
export const localClipProfile = (input: {
  canvas: "landscape" | "portrait";
  seconds: number;
  maxFrames?: number;
  steps?: number;
}): LocalClipProfile | null => {
  const allowed = LOCAL_CLIP_FRAMES.filter((frames) => frames <= (input.maxFrames ?? 33));
  const wanted = Math.ceil(input.seconds * LOCAL_CLIP_FPS);
  const frames = allowed.find((candidate) => candidate >= wanted) ?? allowed.at(-1);
  if (frames === undefined) return null;
  return {
    frames,
    fps: LOCAL_CLIP_FPS,
    ...SIZES[input.canvas],
    steps: Math.min(LOCAL_CLIP_MAX_STEPS, Math.max(1, input.steps ?? LOCAL_CLIP_MAX_STEPS)),
  };
};

/** True for exactly the profiles localClipProfile can return (a generator re-checks its input). */
export const isLocalClipProfile = (profile: LocalClipProfile): boolean =>
  (LOCAL_CLIP_FRAMES as readonly number[]).includes(profile.frames) &&
  profile.fps === LOCAL_CLIP_FPS &&
  Object.values(SIZES).some((s) => s.width === profile.width && s.height === profile.height) &&
  Number.isInteger(profile.steps) &&
  profile.steps >= 1 &&
  profile.steps <= LOCAL_CLIP_MAX_STEPS;
