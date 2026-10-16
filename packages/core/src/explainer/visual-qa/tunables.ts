import type { VisualFinding } from "../../publishing/render-quality.js";

/**
 * Every threshold of the visual QA pack (Stickman v2 spec section 20, slice 28) lives here.
 * All values are HYPOTHESIS until review data from real renders tunes them. Only the spec's
 * objective list may BLOCK; the rest is WARN or INFO.
 */
export const VISUAL_QA_TUNABLES = Object.freeze({
  /**
   * HYPOTHESIS: px a text box may cross SAFE_BOX before BLOCK. The composer centres text at 540
   * (the box centre is 495) and fits it with 0.66 em per glyph while capitals measure 0.72 em,
   * so text it fitted itself can overshoot by about 80 px; only text beyond that is misplaced.
   */
  safeBoxSlackPx: 80,
  /** Spec: actor critically cropped when more of the silhouette than this is outside the frame. */
  cropBlockFraction: 0.4,
  /** Spec: severe collision when actor pixels cover more than this share of a text box. */
  collisionBlockFraction: 0.2,
  /** Spec: caption text contrast floor (WCAG AA). */
  captionContrastMin: 4.5,
  /** Caption plate opacity drawn by the composer (frame.ts drawCaptions). */
  captionPlateOpacity: 0.88,
  /** HYPOTHESIS: rig silhouette half width per unit of height with raised arms. */
  actorHalfWidthPerHeight: 0.4,
  /** HYPOTHESIS: text smaller than this on the 160x284 thumbnail is not legible. */
  thumbMinTextPx: 6,
  /** HYPOTHESIS: hook frame should show accent colour on at least this share of pixels. */
  accentShareMin: 0.003,
  /** HYPOTHESIS: a palette value tier may differ from its target by this much. */
  valueTierTolerance: 0.35,
  /** HYPOTHESIS: hero centre may sit this far (fraction of width) from the nearest hero column. */
  saliencyXTolerance: 0.2,
  /** HYPOTHESIS: a scene with nothing moving longer than this reads as a dead hold. */
  longHoldSec: 6,
  /** HYPOTHESIS: this many identical consecutive compositions read as repetition. */
  repetitionRun: 3,
  /** HYPOTHESIS: colour strip is monotone when every scene is within this OKLab distance of the first. */
  stripMonotonyDistance: 0.04,
  /** HYPOTHESIS: hue change between consecutive scenes above this is a hue walk, degrees. */
  stripHueWalkDeg: 100,
  /** HYPOTHESIS: a scene needs chroma above this for its hue to count in the hue walk check. */
  stripMinChroma: 0.03,
});

export const finding = (
  id: string,
  severity: VisualFinding["severity"],
  sceneIndex?: number,
  detail?: string,
): VisualFinding => ({
  id,
  severity,
  ...(sceneIndex === undefined ? {} : { sceneIndex }),
  ...(detail === undefined ? {} : { detail }),
});

export const blockReasons = (findings: readonly VisualFinding[]): readonly string[] => [
  ...new Set(findings.filter((entry) => entry.severity === "BLOCK").map((entry) => entry.id)),
];
