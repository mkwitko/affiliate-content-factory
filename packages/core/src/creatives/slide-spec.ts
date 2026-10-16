import type { TemplateId } from "./templates.js";

export type SlideSpec = Readonly<{
  index: number;
  total: number;
  template: TemplateId;
  headline: string;
  body?: string;
  badge?: string;
  disclosure?: string;
  /** Generated scene (active workspace image asset) with the product painted in: renders in-scene. */
  sceneAssetId?: string;
  /** The same moment drawn for the story canvas (9:16); story renders fall back to sceneAssetId. */
  storySceneAssetId?: string;
  /**
   * Art direction for this slide's scene (scene-direction.ts), validated against the slide's
   * shot: part of the plan, so the scene prompt and the review read the same line.
   */
  sceneLine?: string;
  sceneLineSource?: "model" | "default";
  /** What the narrator says over this slide in a Reel; without it the Reel reads the copy. */
  voiceLine?: string;
  claims: readonly Readonly<{ text: string; factKey?: string }>[];
}>;

export const MAX_SCENE_LINE_LENGTH = 300;
export const MAX_VOICE_LINE_LENGTH = 140;

export type SlideSpecVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "headline_missing"
        | "headline_too_long"
        | "body_too_long"
        | "badge_too_long"
        | "scene_asset_invalid"
        | "scene_line_too_long"
        | "voice_line_too_long";
    }>;

const normalizeCopy = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const genericHookOpeners = [
  "otima opcao",
  "vale a pena conferir",
  "confira",
  "voce nao vai acreditar",
  "incrivel",
  "imperdivel",
  "perfeito para voce",
];

export const hasGenericHookOpener = (text: string): boolean => {
  const firstLine = normalizeCopy(text.split(/\r?\n/, 1)[0] ?? "");
  return genericHookOpeners.some((opener) => firstLine.startsWith(opener));
};

export type SlideDeckQualityVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "generic_hook" | "repeated_slide_copy" }>;

/** Hard-stop only detectable low-quality patterns before any image generation is queued. */
export const validateSlideDeckQuality = (slides: readonly SlideSpec[]): SlideDeckQualityVerdict => {
  const firstSlide = slides[0];
  if (firstSlide && hasGenericHookOpener(firstSlide.headline))
    return { ok: false, reason: "generic_hook" };

  const seen = new Set<string>();
  for (const slide of slides) {
    const copy = normalizeCopy(`${slide.headline} ${slide.body ?? ""}`);
    if (copy && seen.has(copy)) return { ok: false, reason: "repeated_slide_copy" };
    seen.add(copy);
  }
  return { ok: true };
};

export const SCENE_ASSET_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

export const validateSlideSpec = (spec: SlideSpec): SlideSpecVerdict => {
  if (!spec.headline.trim()) return { ok: false, reason: "headline_missing" };
  if (spec.headline.length > 60) return { ok: false, reason: "headline_too_long" };
  if (spec.body && spec.body.length > 140) return { ok: false, reason: "body_too_long" };
  if (spec.badge && spec.badge.length > 40) return { ok: false, reason: "badge_too_long" };
  for (const id of [spec.sceneAssetId, spec.storySceneAssetId])
    if (id !== undefined && !SCENE_ASSET_ID_PATTERN.test(id))
      return { ok: false, reason: "scene_asset_invalid" };
  if (spec.sceneLine !== undefined && spec.sceneLine.length > MAX_SCENE_LINE_LENGTH)
    return { ok: false, reason: "scene_line_too_long" };
  if (spec.voiceLine !== undefined && spec.voiceLine.length > MAX_VOICE_LINE_LENGTH)
    return { ok: false, reason: "voice_line_too_long" };
  return { ok: true };
};
