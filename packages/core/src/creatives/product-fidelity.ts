import type { PixelBox } from "./creative-renderer.js";

/**
 * Product fidelity (spec section 8.4): deterministic metrics on the aligned product region only,
 * graded against injected thresholds. Pure; the pixel work lives behind FidelityMeasurer in
 * providers. An unmeasured metric is never a pass: it routes the slide to human review.
 */
export type FidelityVerdict = "pass" | "warn" | "block";

export type FidelityInput = Readonly<{
  /** Reference product pixels exactly as composited; alpha is the product mask unless `mask`. */
  original: Uint8Array;
  /** The rendered image that contains the product. */
  rendered: Uint8Array;
  /** Where `original` was composited inside `rendered`, in rendered pixels. */
  region: PixelBox;
  /** Optional greyscale PNG, white = product, same aspect as `original`. */
  mask?: Uint8Array;
}>;

export type FidelityMetrics = Readonly<{
  maskIou: number | null;
  deltaE: number | null;
  msSsim: number | null;
  edgeRecall: number | null;
  edgeExcess: number | null;
  /** Tokens read in the render but not in the original. Empty until OCR lands (follow-up). */
  inventedText: readonly string[];
}>;

export interface FidelityMeasurer {
  measure(input: FidelityInput): Promise<FidelityMetrics>;
}

export type FidelityThresholds = Readonly<{
  id: string;
  block: Readonly<{ maskIouBelow: number; deltaEAbove: number; edgeRecallBelow: number }>;
  warn: Readonly<{
    maskIouBelow: number;
    deltaEAbove: number;
    msSsimBelow: number;
    edgeRecallBelow: number;
    edgeExcessAbove: number;
  }>;
}>;

export type FidelityReport = FidelityMetrics &
  Readonly<{ verdict: FidelityVerdict; reasons: readonly string[]; thresholdSet: string }>;

export type CreativeFidelity = Readonly<{
  verdict: FidelityVerdict;
  slides: readonly (FidelityReport & Readonly<{ slideIndex: number }>)[];
}>;

/**
 * PROVISIONAL, NOT CALIBRATED (spec 8.6). Starting points from
 * docs/audits/2026-09-30-local-ai-research/vision.md checked against one synthetic fixture set.
 * Replace with values read from scripts/fidelity-calibration.mjs on about 50 good and 50 altered
 * real pairs, and give the new set a new `id` so stored reports say which set judged them.
 */
export const PROVISIONAL_FIDELITY_THRESHOLDS: FidelityThresholds = {
  id: "provisional-2026-09-30",
  block: { maskIouBelow: 0.75, deltaEAbove: 20, edgeRecallBelow: 0.5 },
  warn: {
    maskIouBelow: 0.9,
    deltaEAbove: 6,
    msSsimBelow: 0.9,
    edgeRecallBelow: 0.85,
    edgeExcessAbove: 0.2,
  },
};

export const UNMEASURED_FIDELITY: FidelityMetrics = {
  maskIou: null,
  deltaE: null,
  msSsim: null,
  edgeRecall: null,
  edgeExcess: null,
  inventedText: [],
};

const rank: Readonly<Record<FidelityVerdict, number>> = { pass: 0, warn: 1, block: 2 };

export const worstFidelityVerdict = (verdicts: readonly FidelityVerdict[]): FidelityVerdict =>
  verdicts.reduce<FidelityVerdict>(
    (worst, verdict) => (rank[verdict] > rank[worst] ? verdict : worst),
    "pass",
  );

export const judgeFidelity = (
  metrics: FidelityMetrics,
  thresholds: FidelityThresholds,
): FidelityReport => {
  const blocks: string[] = [];
  const warns: string[] = [];
  const grade = (
    name: string,
    value: number | null,
    breaks: (limit: number) => boolean,
    blockAt: number | undefined,
    warnAt: number,
  ) => {
    if (value === null || !Number.isFinite(value)) warns.push(`${name}_unmeasured`);
    else if (blockAt !== undefined && breaks(blockAt)) blocks.push(`${name}_block`);
    else if (breaks(warnAt)) warns.push(`${name}_warn`);
  };
  const { block, warn } = thresholds;
  if (metrics.inventedText.length > 0) blocks.push("invented_text");
  const { maskIou, deltaE, msSsim, edgeRecall, edgeExcess } = metrics;
  grade(
    "maskIou",
    maskIou,
    (limit) => (maskIou ?? 0) < limit,
    block.maskIouBelow,
    warn.maskIouBelow,
  );
  grade("deltaE", deltaE, (limit) => (deltaE ?? 0) > limit, block.deltaEAbove, warn.deltaEAbove);
  grade("msSsim", msSsim, (limit) => (msSsim ?? 0) < limit, undefined, warn.msSsimBelow);
  grade(
    "edgeRecall",
    edgeRecall,
    (limit) => (edgeRecall ?? 0) < limit,
    block.edgeRecallBelow,
    warn.edgeRecallBelow,
  );
  grade(
    "edgeExcess",
    edgeExcess,
    (limit) => (edgeExcess ?? 0) > limit,
    undefined,
    warn.edgeExcessAbove,
  );
  return {
    ...metrics,
    inventedText: [...metrics.inventedText],
    verdict: blocks.length > 0 ? "block" : warns.length > 0 ? "warn" : "pass",
    reasons: [...blocks, ...warns],
    thresholdSet: thresholds.id,
  };
};
