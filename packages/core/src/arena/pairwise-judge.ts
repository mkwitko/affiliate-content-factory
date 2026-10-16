import type { PairwiseJudgment, PairwiseWinner } from "./ranking.js";

/**
 * Blind VLM pairwise judge for image arena cases. The model sees optional reference images
 * (product photo, character sheet) and two candidates labelled A and B, never model names.
 * Criteria are categorical (A/B/TIE), not scores: categorical answers are steadier on small VLMs.
 */
export const PAIRWISE_CRITERIA = [
  "productFidelity",
  "characterFidelity",
  "visualQuality",
  "composition",
  "artifactLevel",
  "commercialUsability",
] as const;
export type PairwiseCriterion = (typeof PAIRWISE_CRITERIA)[number];
const VERDICTS = ["A", "B", "TIE"] as const;

/** Human reject reasons shared by the blind page and the VLM judge. */
export const ARENA_REJECT_REASONS = [
  "BAD_PRODUCT",
  "BAD_FACE",
  "BAD_HAND",
  "BAD_CHARACTER",
  "BAD_COMPOSITION",
  "BAD_TEXT_SPACE",
  "AI_LOOK",
  "LOW_DETAIL",
  "BAD_STYLE",
  "WRONG_COLOR",
  "WRONG_GEOMETRY",
  "OTHER",
] as const;

export const pairwiseJudgeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [...PAIRWISE_CRITERIA, "overallWinner"],
  properties: Object.fromEntries(
    [...PAIRWISE_CRITERIA, "overallWinner"].map((key) => [key, { enum: VERDICTS }]),
  ),
} as const;

export const pairwiseJudgePrompt = (
  input: Readonly<{ brief: string; references: readonly ("product" | "character")[] }>,
): string => {
  const refs = input.references.length
    ? `The first ${input.references.length} image(s) are references: ${input.references.join(", ")}. `
    : "";
  return `${refs}The last two images are candidate A then candidate B, made for this brief: ${input.brief}
Compare A and B for a commercial social post. For each criterion answer "A", "B" or "TIE":
productFidelity (same product as the reference: shape, colour, parts), characterFidelity (same character as the reference sheet), visualQuality (sharpness, clean lines), composition (clear subject, calm space for text), artifactLevel (A if A has FEWER artifacts such as extra fingers, melted objects, gibberish text), commercialUsability (which could be published as is), overallWinner.
Answer TIE when there is no clear difference or the criterion does not apply. Do not prefer an image because of its position. Reply with JSON only.`;
};

export type PairwiseJudgeAnswer = Readonly<
  Record<PairwiseCriterion | "overallWinner", "A" | "B" | "TIE">
>;

/** Strict: null unless every criterion is present and valid. */
export const parsePairwiseJudgeAnswer = (raw: unknown): PairwiseJudgeAnswer | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = [...PAIRWISE_CRITERIA, "overallWinner"] as const;
  if (!keys.every((key) => (VERDICTS as readonly unknown[]).includes(record[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as PairwiseJudgeAnswer;
};

const winnerOf = (verdict: "A" | "B" | "TIE"): PairwiseWinner =>
  verdict === "A" ? "left" : verdict === "B" ? "right" : "tie";

/** One judgment per criterion plus `overall`, as `caseId#criterion` so rankings stay separable. */
export const judgmentsFromAnswer = (
  input: Readonly<{ caseId: string; left: string; right: string; judge: string }>,
  answer: PairwiseJudgeAnswer,
): readonly PairwiseJudgment[] =>
  [...PAIRWISE_CRITERIA, "overallWinner" as const].map((key) => ({
    caseId: key === "overallWinner" ? input.caseId : `${input.caseId}#${key}`,
    left: input.left,
    right: input.right,
    judge: input.judge,
    winner: winnerOf(answer[key]),
  }));
