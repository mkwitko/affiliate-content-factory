import type { VisualFinding } from "../../publishing/render-quality.js";
import { oklab } from "../compositing.js";
import { geometryFor } from "../layout.js";
import { composeMotionFrame } from "../motion/frame.js";
import { type MotionPlan, TRANSITION_MS } from "../motion/plan.js";
import { contrastRatio, type VisualLanguageProfile } from "../visual-language.js";
import { captionColours, outsideSafeBox, type TextBox } from "./scene-graph.js";
import { finding, VISUAL_QA_TUNABLES as T } from "./tunables.js";

/**
 * What the providers measured on one rasterised frame (160x284 thumbnail scale). The decisions
 * live here so thresholds stay in core and the pixel code stays dumb.
 */
export type FrameMetrics = Readonly<{
  /** Actor pixels as a share of the frame, and their centre as fractions of width and height. */
  actorAreaPct: number;
  actorCentroid: Readonly<{ x: number; y: number }> | null;
  /** OKLab L delta between actors and the ring around them; null when there are no actors. */
  focalContrast: number | null;
  accentShare: number;
  valueTiers: readonly [number, number, number];
  dominantArea: number;
  secondaryArea: number;
  meanHex: string;
  /** Per text box: share of it covered by actors, and mean colour of the bare frame under it. */
  texts: readonly Readonly<{ text: TextBox; actorOverlap: number; bgHex: string }>[];
}>;

const channels = (hex: string) => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255] as const;
};
const toHex = (rgb: readonly number[]) =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const blend = (top: string, bottom: string, opacity: number) =>
  toHex(channels(top).map((c, i) => c * opacity + (channels(bottom)[i] ?? 0) * (1 - opacity)));

/** Findings for one frame. `hook` adds the thumbnail-only WARNs (hero area, accent, legibility). */
export const frameFindings = (input: {
  metrics: FrameMetrics;
  plan: MotionPlan;
  sceneIndex: number;
  hook: boolean;
  profile?: VisualLanguageProfile | undefined;
}): readonly VisualFinding[] => {
  const { metrics: m, plan } = input;
  const geo = geometryFor(plan.canvas);
  const at = plan.scenes[input.sceneIndex]?.spec.index;
  const profile = input.profile ?? plan.visualLanguage;
  const { textOn, plate } = captionColours(plan);
  const out: VisualFinding[] = [];
  for (const { text, actorOverlap, bgHex } of m.texts) {
    if (outsideSafeBox(text.box, geo)) out.push(finding("text_outside_safe_box", "BLOCK", at));
    // Captions sit over the lower body by design (feet at the baseline inside the caption band):
    // only scene text (overlays) can collide severely; a covered caption is a WARN.
    if (actorOverlap > T.collisionBlockFraction)
      out.push(
        finding(
          text.kind === "overlay" ? "actor_text_collision" : "actor_caption_overlap",
          text.kind === "overlay" ? "BLOCK" : "WARN",
          at,
          `${Math.round(actorOverlap * 100)}%`,
        ),
      );
    if (text.kind === "caption") {
      const ratio = contrastRatio(textOn, blend(plate, bgHex, T.captionPlateOpacity));
      if (ratio < T.captionContrastMin)
        out.push(finding("caption_contrast", "BLOCK", at, `${ratio}:1`));
    }
    if (
      input.hook &&
      (text.box.bottom - text.box.top) *
        ((geo.canvas === "landscape" ? 284 : 160) / geo.frame.width) <
        T.thumbMinTextPx
    )
      out.push(finding("thumbnail_text_small", "WARN", at));
  }
  if (input.hook) {
    const [lo, hi] = profile?.composition.heroAreaPct ?? [4, 25];
    if (m.actorAreaPct > 0 && (m.actorAreaPct < lo || m.actorAreaPct > hi))
      out.push(finding("hero_area", "WARN", at, `${m.actorAreaPct}%`));
    if (m.accentShare < T.accentShareMin) out.push(finding("accent_missing", "WARN", at));
  }
  if (m.focalContrast !== null && profile && m.focalContrast < profile.value.minFocalDeltaL)
    out.push(finding("focal_contrast_low", "WARN", at, String(m.focalContrast)));
  if (profile) {
    const { areaMax } = profile.palette;
    if (m.dominantArea > areaMax.dominant || m.secondaryArea > areaMax.secondary)
      out.push(finding("palette_proportions", "WARN", at));
    if (
      profile.value.areaTarget.some(
        (target, i) => Math.abs(target - (m.valueTiers[i] ?? 0)) > T.valueTierTolerance,
      )
    )
      out.push(finding("value_tiers", "WARN", at));
    const c = m.actorCentroid;
    if (c) {
      // The profile's hero columns and rows are portrait fractions; landscape reads its own
      // stage columns and the rows between the safe top and the caption band.
      const landscape = geo.canvas === "landscape";
      const [y0, y1] = landscape
        ? [geo.safeBox.top / geo.frame.height, geo.captionBand.top / geo.frame.height]
        : profile.composition.heroYRange;
      const columns = landscape
        ? Object.values(geo.stageX).map((x) => x / geo.frame.width)
        : profile.composition.heroXFractions;
      const dx = Math.min(...columns.map((x) => Math.abs(x - c.x)));
      if (dx > T.saliencyXTolerance || c.y < y0 || c.y > y1)
        out.push(finding("saliency_off_focal", "WARN", at));
    }
  }
  return out;
};

const lab = (hex: string): readonly [number, number, number] => oklab(...channels(hex));

/** Colour strip checks (spec 10.4): monotony and hue walks, WARN only. */
export const stripFindings = (strip: readonly string[]): readonly VisualFinding[] => {
  const labs = strip.map(lab);
  const first = labs[0];
  if (!first || labs.length < 3) return [];
  const out: VisualFinding[] = [];
  if (
    labs.every(
      ([l, a, b]) => Math.hypot(l - first[0], a - first[1], b - first[2]) < T.stripMonotonyDistance,
    )
  )
    out.push(finding("colour_monotony", "WARN"));
  const hue = ([, a, b]: readonly [number, number, number]) => (Math.atan2(b, a) * 180) / Math.PI;
  const chroma = ([, a, b]: readonly [number, number, number]) => Math.hypot(a, b);
  const walk = labs.some((c, i) => {
    const p = labs[i - 1];
    if (!p || chroma(c) < T.stripMinChroma || chroma(p) < T.stripMinChroma) return false;
    const d = Math.abs(hue(c) - hue(p)) % 360;
    return Math.min(d, 360 - d) > T.stripHueWalkDeg;
  });
  if (walk) out.push(finding("colour_hue_walk", "WARN"));
  return out;
};

/** When the key frame of a scene is taken: after the cut settled, near the hook's 1.4 s still. */
export const keyFrameMs = (plan: MotionPlan, sceneIndex: number): number => {
  const scene = plan.scenes[sceneIndex];
  if (!scene) throw new Error("motion_plan_empty");
  const length = scene.endMs - scene.startMs;
  return (
    scene.startMs +
    Math.max(0, Math.min(1400, Math.max(TRANSITION_MS + 100, length * 0.6), length - 1))
  );
};

/** SVGs of one frame: as viewers see it, without actors, and bare (no actors, no text). */
export const frameVariants = (
  plan: MotionPlan,
  sceneIndex: number,
  t: number,
): Readonly<{ full: string; noActors: string; bare: string }> => {
  const scene = plan.scenes[sceneIndex];
  if (!scene) throw new Error("motion_plan_empty");
  const swap = (replacement: typeof scene): MotionPlan => ({
    ...plan,
    scenes: plan.scenes.map((entry, i) => (i === sceneIndex ? replacement : entry)),
  });
  return {
    full: composeMotionFrame(plan, t),
    noActors: composeMotionFrame(swap({ ...scene, actors: [] }), t),
    bare: composeMotionFrame(swap({ ...scene, actors: [], overlays: [], captions: [] }), t),
  };
};
