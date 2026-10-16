import { rigBuildFor } from "./character-bible.js";
import type { ExplainerCharacter } from "./explainer-context.js";
import { type PoseId, poseAngles, renderStickmanFrame } from "./rigs/stick-v1.js";

/**
 * Silhouette identity (Stickman v2 spec 11.2, slice 19): each rigged character drawn solid
 * black in three poses, feet on one baseline, rasterised at 64x96 by a provider; pairs whose
 * shapes overlap too much, or that differ in fewer than two traits, get a WARN. Runs when the
 * cast changes, never at render time. Thresholds are HYPOTHESIS until the first cast of six.
 */
export const SILHOUETTE_POSES: readonly PoseId[] = ["neutral", "walking", "celebrating"];
export const SILHOUETTE_SIZE = Object.freeze({ width: 64, height: 96 });
export const SILHOUETTE_IOU_MAX = 0.75;
export const HEIGHT_CLASS_DELTA = 0.12;
const CANVAS = { width: 640, height: 960, baselineY: 930 };
const INK = "#000000";

export const silhouetteSvg = (character: ExplainerCharacter, pose: PoseId): string => {
  const wardrobe = character.wardrobe;
  const figure = renderStickmanFrame({
    angles: poseAngles(pose),
    expression: "neutral",
    palette: { line: INK, fill: INK, accent: INK },
    x: CANVAS.width / 2,
    baselineY: CANVAS.baselineY,
    scale: character.bible?.body.scale ?? 1,
    accessory: character.accessory,
    wardrobe: wardrobe
      ? {
          ...wardrobe,
          ...(wardrobe.hair ? { hair: { ...wardrobe.hair, colour: INK } } : {}),
          ...(wardrobe.top ? { top: { ...wardrobe.top, colour: INK } } : {}),
          ...(wardrobe.bottoms ? { bottoms: { ...wardrobe.bottoms, colour: INK } } : {}),
        }
      : undefined,
    extremities: true,
    shadowCast: { dx: 0, dy: 0, strength: 0 },
    ...(character.bible ? { build: rigBuildFor(character.bible) } : {}),
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}"><rect width="${CANVAS.width}" height="${CANVAS.height}" fill="#ffffff"/>${figure}</svg>`;
};

/** A binary mask, row-major, 1 = figure. */
export type SilhouetteMask = Readonly<{ width: number; height: number; data: Uint8Array }>;

export const iou = (a: SilhouetteMask, b: SilhouetteMask): number => {
  if (a.width !== b.width || a.height !== b.height) throw new Error("silhouette_size_mismatch");
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    const x = a.data[i] ?? 0;
    const y = b.data[i] ?? 0;
    if (x && y) both += 1;
    if (x || y) either += 1;
  }
  return either === 0 ? 0 : Math.round((both / either) * 1000) / 1000;
};

/** Figure height in mask rows (feet share the baseline, so this is the height class). */
export const maskHeight = (mask: SilhouetteMask): number => {
  let top = mask.height;
  let bottom = -1;
  for (let y = 0; y < mask.height; y += 1)
    for (let x = 0; x < mask.width; x += 1)
      if (mask.data[y * mask.width + x]) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return bottom < top ? 0 : bottom - top + 1;
};

export type SilhouettePair = Readonly<{
  a: string;
  b: string;
  /** Mean IoU over the three poses. */
  iou: number;
  distinctTraits: readonly string[];
}>;
export type SilhouetteReport = Readonly<{
  pairs: readonly SilhouettePair[];
  warnings: readonly string[];
}>;

const headShape = (c: ExplainerCharacter) =>
  `${c.bible?.body.head ?? "circle"}:${c.wardrobe?.head ?? "standard"}`;
const signature = (c: ExplainerCharacter) => c.bible?.body.signature ?? c.accessory ?? "none";

export const silhouetteReport = (
  cast: readonly ExplainerCharacter[],
  masks: ReadonlyMap<string, readonly SilhouetteMask[]>,
  iouMax = SILHOUETTE_IOU_MAX,
): SilhouetteReport => {
  const pairs: SilhouettePair[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < cast.length; i += 1)
    for (let j = i + 1; j < cast.length; j += 1) {
      const a = cast[i] as ExplainerCharacter;
      const b = cast[j] as ExplainerCharacter;
      const ma = masks.get(a.key);
      const mb = masks.get(b.key);
      if (!ma || !mb) continue;
      const values = ma.map((mask, k) => iou(mask, mb[k] as SilhouetteMask));
      const mean = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 1000) / 1000;
      const ha = maskHeight(ma[0] as SilhouetteMask);
      const hb = maskHeight(mb[0] as SilhouetteMask);
      const traits = [
        ...(Math.abs(ha - hb) / Math.max(1, ha, hb) >= HEIGHT_CLASS_DELTA ? ["height_class"] : []),
        ...(headShape(a) !== headShape(b) ? ["head_shape"] : []),
        ...((a.wardrobe?.hair?.style ?? "none") !== (b.wardrobe?.hair?.style ?? "none")
          ? ["hair_mass"]
          : []),
        ...(signature(a) !== signature(b) ? ["signature_accessory"] : []),
        ...((a.bible?.body.archetype ?? "average") !== (b.bible?.body.archetype ?? "average")
          ? ["build"]
          : []),
      ];
      pairs.push({ a: a.key, b: b.key, iou: mean, distinctTraits: traits });
      if (mean > iouMax) warnings.push(`silhouette_iou:${a.key}:${b.key}`);
      if (traits.length < 2) warnings.push(`silhouette_not_distinct:${a.key}:${b.key}`);
    }
  return { pairs, warnings };
};
