/**
 * Which listing photo becomes the product reference for the in-scene editor (owner brief
 * 2026-10-08, section 11.1: never just the first usable file). Pure: the measurements come
 * from a provider, the ranking is deterministic and ties keep the listing order.
 */
export type ReferenceEvidence = Readonly<{
  /** Laplacian variance of the greyscale image at 256 px; blur reads low, detail reads high. */
  sharpness: number;
  /** Share of border pixels that are near white: a clean studio background cuts out well. */
  whiteBorderShare: number;
  width: number;
  height: number;
}>;

export type ReferenceCandidate<T> = Readonly<{ id: T; evidence: ReferenceEvidence }>;

// ponytail: fixed weights, uncalibrated; fit them against owner picks once a few packages exist.
const WEIGHTS = Object.freeze({ sharpness: 0.4, resolution: 0.3, background: 0.3 });
const SHARP_ENOUGH = 200;
const LARGE_ENOUGH_PX = 800;

/** 0..1, higher is a better reference for the editor. */
export const referenceScore = (evidence: ReferenceEvidence): number => {
  const sharpness = Math.min(1, Math.max(0, evidence.sharpness) / SHARP_ENOUGH);
  const resolution = Math.min(1, Math.min(evidence.width, evidence.height) / LARGE_ENOUGH_PX);
  const background = Math.min(1, Math.max(0, evidence.whiteBorderShare));
  return (
    WEIGHTS.sharpness * sharpness +
    WEIGHTS.resolution * resolution +
    WEIGHTS.background * background
  );
};

/** The best candidate, or null when there is none; equal scores keep the earlier one. */
export const pickReference = <T>(
  candidates: readonly ReferenceCandidate<T>[],
): Readonly<{ id: T; score: number }> | null => {
  let best: { id: T; score: number } | null = null;
  for (const candidate of candidates) {
    const score = referenceScore(candidate.evidence);
    if (!best || score > best.score) best = { id: candidate.id, score };
  }
  return best;
};
