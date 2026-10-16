export type MaskMetrics = Readonly<{
  coverage: number;
  margin: number;
  components: number;
  largestRatio: number;
  whiteness: number;
  contrast: number;
}>;

export const CUTOUT_THRESHOLDS = {
  coverageMin: 0.05,
  coverageMax: 0.75,
  marginMin: 0.01,
  largestRatioMin: 0.85,
  whitenessMin: 0.6,
  contrastMin: 25,
} as const;

export type CutoutVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "coverage_low"
        | "coverage_high"
        | "touches_edge"
        | "fragmented"
        | "background_not_white"
        | "low_contrast";
    }>;

/** Geometry checks shared by the white-background cutout and AI segmentation. */
const judgeShape = (metrics: MaskMetrics): CutoutVerdict => {
  if (metrics.coverage < CUTOUT_THRESHOLDS.coverageMin)
    return { ok: false, reason: "coverage_low" };
  if (metrics.coverage > CUTOUT_THRESHOLDS.coverageMax)
    return { ok: false, reason: "coverage_high" };
  if (metrics.margin < CUTOUT_THRESHOLDS.marginMin) return { ok: false, reason: "touches_edge" };
  if (metrics.components < 1 || metrics.largestRatio < CUTOUT_THRESHOLDS.largestRatioMin)
    return { ok: false, reason: "fragmented" };
  return { ok: true };
};

export const judgeCutout = (metrics: MaskMetrics): CutoutVerdict => {
  if (metrics.contrast < CUTOUT_THRESHOLDS.contrastMin)
    return { ok: false, reason: "low_contrast" };
  if (metrics.whiteness < CUTOUT_THRESHOLDS.whitenessMin)
    return { ok: false, reason: "background_not_white" };
  return judgeShape(metrics);
};

/**
 * PROVISIONAL, NOT CALIBRATED: share of decisive mask pixels an AI segmentation needs before its
 * cutout replaces the framed photo (spec 8.3, slice 6 calibrates it on real photos).
 */
export const PROVISIONAL_SEGMENT_MIN_CONFIDENCE = 0.9;

export type SegmentationVerdict = CutoutVerdict | Readonly<{ ok: false; reason: "low_confidence" }>;

/**
 * An AI mask is judged on confidence and geometry only: its background is not white by
 * definition, so whiteness and contrast-against-white do not apply.
 */
export const judgeSegmentation = (
  metrics: MaskMetrics,
  confidence: number,
  minConfidence: number,
): SegmentationVerdict =>
  confidence >= minConfidence ? judgeShape(metrics) : { ok: false, reason: "low_confidence" };
