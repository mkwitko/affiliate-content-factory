import { BACKGROUND_ART_BOX } from "./background-art.js";
import { BASELINE_Y, SAFE_BOX } from "./layout.js";

/**
 * CompositingProfile (Stickman v2 spec section 10.3, slice 14): how the painted plate and the
 * rig are made to read as one picture. Applied by the planner, the composer and the plate
 * import, never by a scene director. Every threshold is a tunable with a HYPOTHESIS default
 * until the style-frame review measures the accepted frames (slice 18).
 */
export type CompositingProfile = Readonly<{
  version: 1;
  /** OKLab L delta between the actor silhouette and the ring around it (0..1). */
  focalContrastTarget: number;
  /** Plate mean chroma as a fraction of the character accent's chroma. */
  backgroundChromaCap: number;
  /** Max OKLab L standard deviation of the plate inside the actor halo band (0..1). */
  actorHaloVarianceMax: number;
  valueTiers: readonly [number, number, number];
  lighting: Readonly<{
    /** Where the key light comes from, degrees clockwise from straight up (0 = top, 90 = right). */
    directionDeg: number;
    /** Multiplies the rig's contact-shadow opacity; 1 keeps today's shadow. */
    shadowStrength: number;
    /** Contact-shadow offset in px at scale 1; [0, 0] keeps today's shadow. */
    shadowOffset: readonly [number, number];
  }>;
  /** Share of the stage camera each layer follows; 1 moves with the actors. */
  depth: Readonly<{ far: number; mid: number; hero: number; near: number; farValuePull: number }>;
  /** A light edge on the lit side of every actor (drawn as an offset silhouette, no filter). */
  rim?: Readonly<{ enabled: boolean; widthPx: number; colour?: string | undefined }> | undefined;
  /** Additive to the spec type: Gaussian blur baked into far plates at import, px (0 = none). */
  farBlurPx?: number | undefined;
}>;

/**
 * Today's output, field for field: the painted plate at half the camera (the former
 * PARALLAX_DEPTH), the procedural setting and the cast at full camera, today's shadow, no rim,
 * no plate processing. Spec 10.3 lists mid 0.5 as the reproducing default, but today the
 * procedural setting moves with the stage (depth 1), so mid is 1 here (recorded spec drift).
 */
export const DEFAULT_COMPOSITING: CompositingProfile = Object.freeze({
  version: 1,
  focalContrastTarget: 0.25,
  backgroundChromaCap: 0.6,
  actorHaloVarianceMax: 0.08,
  valueTiers: Object.freeze([0.2, 0.5, 0.85] as const),
  lighting: Object.freeze({
    directionDeg: 0,
    shadowStrength: 1,
    shadowOffset: Object.freeze([0, 0] as const),
  }),
  depth: Object.freeze({ far: 0.5, mid: 1, hero: 1, near: 1, farValuePull: 0 }),
});

/**
 * The research numbers of spec 10.3 (HYPOTHESIS), for the style-frame harness only: stronger
 * depth separation, a far value pull, a soft far blur, a key light from the top left and a rim.
 */
export const COMPOSITING_HYPOTHESIS: CompositingProfile = Object.freeze({
  ...DEFAULT_COMPOSITING,
  lighting: Object.freeze({
    directionDeg: 315,
    shadowStrength: 1.3,
    shadowOffset: Object.freeze([18, 4] as const),
  }),
  depth: Object.freeze({ far: 0.2, mid: 0.6, hero: 1, near: 1.4, farValuePull: 0.3 }),
  rim: Object.freeze({ enabled: true, widthPx: 5 }),
  farBlurPx: 1.5,
});

export const DEFAULT_RIM_COLOUR = "#FFF6E0";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

/**
 * A niche's stored profile (explainer.compositing), every field optional, resolved against the
 * default. Absent or not an object → null, which keeps today's rendering path untouched.
 */
export const readCompositingProfile = (value: unknown): CompositingProfile | null => {
  if (!isRecord(value)) return null;
  const d = DEFAULT_COMPOSITING;
  const lighting = isRecord(value.lighting) ? value.lighting : {};
  const depth = isRecord(value.depth) ? value.depth : {};
  const offset = Array.isArray(lighting.shadowOffset) ? lighting.shadowOffset : [];
  const tiers = Array.isArray(value.valueTiers) ? value.valueTiers : [];
  const rim = isRecord(value.rim) ? value.rim : null;
  return Object.freeze({
    version: 1,
    focalContrastTarget: num(value.focalContrastTarget, d.focalContrastTarget, 0, 1),
    backgroundChromaCap: num(value.backgroundChromaCap, d.backgroundChromaCap, 0, 2),
    actorHaloVarianceMax: num(value.actorHaloVarianceMax, d.actorHaloVarianceMax, 0, 1),
    valueTiers: Object.freeze([
      num(tiers[0], d.valueTiers[0], 0, 1),
      num(tiers[1], d.valueTiers[1], 0, 1),
      num(tiers[2], d.valueTiers[2], 0, 1),
    ] as const),
    lighting: Object.freeze({
      directionDeg: num(lighting.directionDeg, d.lighting.directionDeg, 0, 360),
      shadowStrength: num(lighting.shadowStrength, d.lighting.shadowStrength, 0, 3),
      shadowOffset: Object.freeze([
        num(offset[0], d.lighting.shadowOffset[0], -80, 80),
        num(offset[1], d.lighting.shadowOffset[1], -80, 80),
      ] as const),
    }),
    depth: Object.freeze({
      far: num(depth.far, d.depth.far, 0, 2),
      mid: num(depth.mid, d.depth.mid, 0, 2),
      hero: num(depth.hero, d.depth.hero, 0, 2),
      near: num(depth.near, d.depth.near, 0, 2),
      farValuePull: num(depth.farValuePull, d.depth.farValuePull, 0, 1),
    }),
    ...(rim
      ? {
          rim: Object.freeze({
            enabled: rim.enabled === true,
            widthPx: num(rim.widthPx, 4, 1, 16),
            ...(isHex(rim.colour) ? { colour: rim.colour } : {}),
          }),
        }
      : {}),
    ...(typeof value.farBlurPx === "number" ? { farBlurPx: num(value.farBlurPx, 0, 0, 12) } : {}),
  });
};

/** Unit vector toward the key light in screen space (y down). */
export const lightVector = (profile: CompositingProfile): Readonly<{ x: number; y: number }> => {
  const rad = (profile.lighting.directionDeg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
};

/** True when the profile draws exactly what the composer draws without one. */
export const isNeutralCompositing = (profile: CompositingProfile): boolean =>
  profile.depth.far === DEFAULT_COMPOSITING.depth.far &&
  profile.depth.mid === 1 &&
  profile.depth.hero === 1 &&
  profile.lighting.shadowStrength === 1 &&
  profile.lighting.shadowOffset[0] === 0 &&
  profile.lighting.shadowOffset[1] === 0 &&
  profile.rim?.enabled !== true;

/**
 * Where actors stand on a plate, as fractions of the plate height: the frame band from the top
 * of SAFE_BOX to just under the baseline, mapped through BACKGROUND_ART_BOX. Holds for plates at
 * least as wide as the 9:16 box (768x1344 and 1024x1024), whose height maps fully.
 */
export const HALO_BAND = Object.freeze({
  top: (SAFE_BOX.top - BACKGROUND_ART_BOX.y) / BACKGROUND_ART_BOX.height,
  bottom: (BASELINE_Y + 40 - BACKGROUND_ART_BOX.y) / BACKGROUND_ART_BOX.height,
});

/** What the import does to a plate for a profile; pure, so providers only execute it. */
export type PlatePostProcessPlan = Readonly<{
  compositingVersion: 1;
  /** Absolute OKLab chroma the plate mean may reach (cap × accent chroma). */
  maxMeanChroma: number;
  haloBand: Readonly<{ top: number; bottom: number }>;
  haloStdMax: number;
  farValuePull: number;
  /** sRGB hex the far value pull blends toward (the palette surface: aerial haze). */
  pullTarget: string;
  blurSigma: number;
}>;

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
/** OKLab of an sRGB triple in 0..255 (Björn Ottosson's matrices). */
export const oklab = (r: number, g: number, b: number): readonly [number, number, number] => {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
export const hexChroma = (hex: string): number => {
  const v = Number.parseInt(hex.slice(1), 16);
  const [, a, b] = oklab((v >> 16) & 255, (v >> 8) & 255, v & 255);
  return Math.hypot(a, b);
};

export const platePostProcessPlan = (
  profile: CompositingProfile,
  palette: Readonly<{ accent: string; surface: string }>,
): PlatePostProcessPlan => ({
  compositingVersion: 1,
  maxMeanChroma: profile.backgroundChromaCap * hexChroma(palette.accent),
  haloBand: HALO_BAND,
  haloStdMax: profile.actorHaloVarianceMax,
  farValuePull: profile.depth.farValuePull,
  pullTarget: palette.surface,
  blurSigma: profile.farBlurPx ?? 0,
});
