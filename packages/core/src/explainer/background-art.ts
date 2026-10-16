import type { WorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import type { SceneBankRequest } from "../creatives/scene-bank.js";
import type { BackgroundId } from "./backgrounds.js";
import { type CanvasGeometry, PORTRAIT_GEOMETRY } from "./layout.js";

/**
 * Painted explainer backgrounds: raster assets drawn under the stickman_motion stage instead of
 * the procedural BackgroundId. Generative models only ever make these and their ambient loops,
 * never characters, products or text (spec INV-03).
 */
export const EXPLAINER_BACKGROUND_ROLE = "explainer_background";

/** A background a scene may draw: this workspace's, active, PNG or JPEG, with commercial rights. */
export const isUsableBackground = (
  asset: Asset | null | undefined,
  workspaceId: WorkspaceId,
): asset is Asset =>
  !!asset &&
  asset.workspaceId === workspaceId &&
  asset.state === "active" &&
  (asset.mimeType === "image/png" || asset.mimeType === "image/jpeg") &&
  asset.commercialUse === true &&
  asset.metadata?.role === EXPLAINER_BACKGROUND_ROLE;

/**
 * A background resolved for one render: the still as a data URI and, when an approved ambient
 * loop is attached, its frames (JPEG data URIs at BACKGROUND_ART_BOX size) played at fps.
 */
export type BackgroundArt = Readonly<{
  href: string;
  loop?: Readonly<{ frames: readonly string[]; fps: number }> | undefined;
}>;
/**
 * Where the art is drawn, in frame px: 60/106 px of bleed per side, so the far layer (half the
 * camera's pan, shake and zoom) never shows a frame edge. Loop frames are extracted at this size.
 */
export const BACKGROUND_ART_BOX = Object.freeze({
  x: -60,
  y: -106,
  width: 1200,
  height: 2132,
} as const);

/** Niche art styles: the painted-background style block and, later, the rig's line. */
export const EXPLAINER_ART_STYLES = ["flat_cartoon", "sketch_watercolor"] as const;
export type ExplainerArtStyle = (typeof EXPLAINER_ART_STYLES)[number];
/** Bump when any prompt text below changes: it versions the bank keys. */
export const EXPLAINER_BACKGROUND_PROMPT_VERSION = 1;
/** Asked of generators that choose a size (sd.cpp, mflux: multiples of 64, 9:16). */
export const EXPLAINER_BACKGROUND_SIZE = Object.freeze({ width: 768, height: 1344 } as const);
export const EXPLAINER_BACKGROUND_POOL_MIN = 2;

const STYLE_BLOCKS: Readonly<Record<ExplainerArtStyle, string>> = {
  flat_cartoon:
    "clean flat 2D cartoon illustration, bold simple shapes, soft cel shading, warm directional light, gentle depth with a lighter far background",
  sketch_watercolor:
    "hand-drawn sketch illustration, loose ink outlines, soft watercolor washes on textured paper, warm light and soft shadows, atmospheric depth",
};
const SETTINGS: Readonly<Record<BackgroundId, string>> = {
  plain: "an empty softly lit studio backdrop with a plain floor",
  grid: "a tidy classroom wall with a blank chalkboard and a wooden floor",
  bank: "a bank branch interior with counters and tall windows",
  store: "a supermarket aisle with stocked shelves fading into the distance",
  office: "a small office with a desk, a plant and a window",
  street: "a city street with shop fronts and a wide sidewalk",
  sky: "an open sky over rolling green hills",
  kitchen: "a home kitchen with counters, cabinets and a window",
  airport: "an airport terminal hall with large windows and planes outside",
  lab: "a science lab with benches and glassware",
};
/** Never changes without a version bump: the stage and the INV-03 exclusions. */
const LOCKED =
  "vertical 9:16 composition, eye-level wide view, empty open floor across the lower third as a stage, uncluttered middle, no people, no characters, no animals, no text, no letters, no numbers, no signs with writing, no logos, no products, no brand names";

export const explainerBackgroundPrompt = (input: {
  setting: BackgroundId;
  style: ExplainerArtStyle;
  paletteHint: string;
}): string =>
  `${SETTINGS[input.setting]}, ${STYLE_BLOCKS[input.style]}, ${input.paletteHint} palette, ${LOCKED}`;

/**
 * Location plates (v2 slice 24): one wide painting per niche location, generated once and cropped
 * by camera zones. Its own versioned template, so changing it never re-keys the setting bank.
 */
export const LOCATION_PLATE_TEMPLATE_VERSION = 1;
/** Asked of generators that choose a size: wider than 9:16 so zones can crop and pan (spec 12). */
export const LOCATION_PLATE_SIZE = Object.freeze({ width: 1216, height: 1344 } as const);
const LOCKED_PANORAMA =
  "wide establishing panorama, eye-level, continuous open floor across the lower third, several distinct areas left to right, no people, no characters, no animals, no text, no letters, no numbers, no signs with writing, no logos, no products, no brand names";

export const locationPlatePrompt = (input: {
  name: string;
  setting: BackgroundId;
  style: ExplainerArtStyle;
  paletteHint: string;
}): string =>
  `${SETTINGS[input.setting]}, the recurring place called ${input.name.replace(/[^\p{L}\p{N} ]/gu, "").slice(0, 40)}, ${STYLE_BLOCKS[input.style]}, ${input.paletteHint} palette, ${LOCKED_PANORAMA}`;

export const locationPlateKey = (
  nicheId: string,
  input: { locationId: string; style: ExplainerArtStyle },
): string =>
  `${nicheId}:location:${input.locationId}:${input.style}:t${LOCATION_PLATE_TEMPLATE_VERSION}`;

export const locationPlateRequest = (
  nicheId: string,
  input: {
    locationId: string;
    name: string;
    setting: BackgroundId;
    style: ExplainerArtStyle;
    paletteHint: string;
  },
): SceneBankRequest => ({
  role: EXPLAINER_BACKGROUND_ROLE,
  key: locationPlateKey(nicheId, input),
  prompt: locationPlatePrompt(input),
  // One plate serves the whole location; variation comes from zone crops and grades.
  poolMin: 1,
  size: LOCATION_PLATE_SIZE,
  metadata: {
    nicheId,
    locationId: input.locationId,
    setting: input.setting,
    style: input.style,
    promptVersion: EXPLAINER_BACKGROUND_PROMPT_VERSION,
    promptTemplateVersion: LOCATION_PLATE_TEMPLATE_VERSION,
  },
});

/**
 * Where a location plate is drawn: the normal art box widened by the plate's overscan (width
 * factor o, height factor 1 + (o - 1) / 3, so 2.2 gives the spec's 2.2 x 1.4).
 */
export const plateBox = (overscan: number, geometry: CanvasGeometry = PORTRAIT_GEOMETRY) => {
  const o = Math.max(1, overscan);
  const width = geometry.artBox.width * o;
  const height = geometry.artBox.height * (1 + (o - 1) / 3);
  return Object.freeze({
    x: geometry.frame.width / 2 - width / 2,
    y: geometry.frame.height / 2 - height / 2,
    width,
    height,
  });
};

export const explainerBackgroundKey = (
  nicheId: string,
  input: { setting: BackgroundId; style: ExplainerArtStyle },
): string =>
  `${nicheId}:explainer:${input.setting}:${input.style}:v${EXPLAINER_BACKGROUND_PROMPT_VERSION}`;

export const explainerBackgroundRequest = (
  nicheId: string,
  input: { setting: BackgroundId; style: ExplainerArtStyle; paletteHint: string },
): SceneBankRequest => ({
  role: EXPLAINER_BACKGROUND_ROLE,
  key: explainerBackgroundKey(nicheId, input),
  prompt: explainerBackgroundPrompt(input),
  poolMin: EXPLAINER_BACKGROUND_POOL_MIN,
  size: EXPLAINER_BACKGROUND_SIZE,
  metadata: {
    nicheId,
    setting: input.setting,
    style: input.style,
    promptVersion: EXPLAINER_BACKGROUND_PROMPT_VERSION,
  },
});

export type LineStyle = "clean" | "sketch";
/** The rig line that matches a niche style: watercolor sketches get hand-drawn figures. */
export const explainerLineStyle = (style: ExplainerArtStyle | undefined): LineStyle =>
  style === "sketch_watercolor" ? "sketch" : "clean";

/**
 * Ambient loops: short background-only videos (never characters or products, INV-03) made once
 * on a home machine, attached to a background asset through metadata.backgroundAssetId.
 */
export const AMBIENT_LOOP_ROLE = "ambient_loop";
export const AMBIENT_LOOP_LIMITS = Object.freeze({
  minMs: 1_000,
  maxMs: 6_000,
  maxBytes: 20_000_000,
  maxFrames: 180,
  fps: 30,
} as const);
/** Mean absolute luma difference (0-255) on 108x192 frames: frame to frame, and last to first. */
export type AmbientLoopMeasure = Readonly<{ durationMs: number; motion: number; seam: number }>;
export type AmbientLoopVerdict =
  | Readonly<{ verdict: "pass" }>
  | Readonly<{ verdict: "block"; reason: "loop_duration" | "loop_frozen" | "loop_seam" }>;
// ponytail: thresholds set from four measured fixtures, not calibrated; tune on the first ten
// real loops (a visible pop is a seam several times larger than a normal frame step).
const FROZEN_BELOW = 0.15;
const SEAM_FLOOR = 1.5;
const SEAM_FACTOR = 3;
export const ambientLoopVerdict = (measure: AmbientLoopMeasure): AmbientLoopVerdict =>
  measure.durationMs < AMBIENT_LOOP_LIMITS.minMs || measure.durationMs > AMBIENT_LOOP_LIMITS.maxMs
    ? { verdict: "block", reason: "loop_duration" }
    : measure.motion < FROZEN_BELOW
      ? { verdict: "block", reason: "loop_frozen" }
      : measure.seam > Math.max(SEAM_FLOOR, SEAM_FACTOR * measure.motion)
        ? { verdict: "block", reason: "loop_seam" }
        : { verdict: "pass" };

/** How a local asset was made (spec section 6); stored as Asset.metadata.generation. */
export type GenerationProvenance = Readonly<{
  model: string;
  weightsLicense: string;
  tool: string;
  seed: number;
  prompt: string;
  promptVersion?: number;
}>;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
export const readGenerationProvenance = (value: unknown): GenerationProvenance | null => {
  if (typeof value !== "object" || value === null) return null;
  const { model, weightsLicense, tool, seed, prompt, promptVersion } = value as Record<
    string,
    unknown
  >;
  if (
    !text(model, 100) ||
    !text(weightsLicense, 200) ||
    !text(tool, 200) ||
    !text(prompt, 2_000) ||
    typeof seed !== "number" ||
    !Number.isSafeInteger(seed) ||
    seed < 0
  )
    return null;
  return Object.freeze({
    model,
    weightsLicense,
    tool,
    seed,
    prompt,
    ...(typeof promptVersion === "number" && Number.isInteger(promptVersion)
      ? { promptVersion }
      : {}),
  });
};

export const isUsableLoop = (
  asset: Asset,
  workspaceId: WorkspaceId,
  backgroundAssetId: string,
): boolean => {
  const metadata = asset.metadata ?? {};
  const qa = metadata.qa as Readonly<{ verdict?: unknown }> | undefined;
  return (
    asset.workspaceId === workspaceId &&
    asset.state === "active" &&
    asset.mimeType === "video/mp4" &&
    asset.commercialUse === true &&
    asset.durationMs !== undefined &&
    asset.durationMs >= AMBIENT_LOOP_LIMITS.minMs &&
    asset.durationMs <= AMBIENT_LOOP_LIMITS.maxMs &&
    metadata.role === AMBIENT_LOOP_ROLE &&
    metadata.backgroundAssetId === backgroundAssetId &&
    qa?.verdict === "pass" &&
    readGenerationProvenance(metadata.generation) !== null
  );
};

export const ambientLoopPrompt = (input: {
  setting: BackgroundId;
  style: ExplainerArtStyle;
  paletteHint: string;
}): string =>
  `${explainerBackgroundPrompt(input)}, subtle ambient motion only: drifting light, slow clouds, soft steam or gently swaying leaves, static camera, seamless loop`;
