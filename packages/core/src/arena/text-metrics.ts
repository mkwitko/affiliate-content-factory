import { expandSpokenPtBr } from "../assets/spoken-text.js";

/**
 * Transcript comparison for the speech arenas. Both sides go through the pt-BR spoken form (so
 * "R$ 48,99" and "quarenta e oito reais..." match), lower case, no diacritics (an ASR writing
 * "miliamperes" for "miliampères" is not a speech error) and no punctuation.
 */
export const normalizeForErrorRate = (text: string): string =>
  expandSpokenPtBr(text)
    .spoken.toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const editDistance = <T>(a: readonly T[], b: readonly T[]): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length] as number;
};

/** Edit distance over reference length; 0 is perfect, can exceed 1 for very long hypotheses. */
const rate = <T>(reference: readonly T[], hypothesis: readonly T[]): number =>
  reference.length === 0
    ? hypothesis.length === 0
      ? 0
      : 1
    : editDistance(reference, hypothesis) / reference.length;

export const characterErrorRate = (reference: string, hypothesis: string): number =>
  rate([...normalizeForErrorRate(reference)], [...normalizeForErrorRate(hypothesis)]);

export const wordErrorRate = (reference: string, hypothesis: string): number => {
  const words = (text: string) => normalizeForErrorRate(text).split(" ").filter(Boolean);
  return rate(words(reference), words(hypothesis));
};
