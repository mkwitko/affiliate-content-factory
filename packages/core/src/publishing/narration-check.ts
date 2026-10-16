import { normalizeForErrorRate, wordErrorRate } from "../arena/text-metrics.js";

/**
 * Narration check (v3 backlog 3): the ASR transcript of a rendered Reel against its voice script.
 * Every price, percent and number written in the script must be heard; a missing one blocks the
 * Reel like a wrong written price. The word error rate is recorded for the operator, never graded.
 * Pure: the transcript comes from an untrusted home machine and is only compared here.
 */

/** The only ASR the narration check accepts (Parakeet v3, the arena champion). */
export const NARRATION_ASR_MODEL = "local:parakeet-tdt-0.6b-v3";
export const MAX_TRANSCRIPT_LENGTH = 6_000;

export type NarrationCheck = Readonly<{
  verdict: "pass" | "block";
  /** Word error rate of transcript vs script, 0..; informational. */
  wer: number;
  /** Script numbers (as written) that the transcript does not contain. */
  missing: readonly string[];
  model: string;
  checkedAt: string;
}>;

/** "R$ 329,90", "1.500", "15%", "12", "5,5": digits with their separators. */
const NUMBER_TOKEN = /(?:R\$\s?)?\d[\d.,]*\d%?|(?:R\$\s?)?\d%?/gu;

/** Digit runs of a text with thousands and decimal separators removed ("329,90" -> "32990"). */
const digitRuns = (text: string): readonly string[] =>
  text.replace(/(?<=\d)[.,](?=\d)/gu, "").match(/\d+/gu) ?? [];

const wordsOf = (text: string): string => ` ${normalizeForErrorRate(text)} `;

/** Numbers written in the script lines, deduplicated, in order of appearance. */
export const scriptNumbers = (lines: readonly string[]): readonly string[] => [
  ...new Set(lines.flatMap((line) => line.match(NUMBER_TOKEN) ?? []).map((n) => n.trim())),
];

export const compareNarration = (
  lines: readonly string[],
  transcript: string,
  input: Readonly<{ model: string; now: Date }>,
): NarrationCheck => {
  const heardDigits = new Set(digitRuns(transcript));
  const heardWords = wordsOf(transcript);
  // "2" is "dois" or "duas" depending on the noun that follows it in the script: try both.
  const heard = (digits: string) =>
    heardDigits.has(digits) ||
    [wordsOf(digits), wordsOf(`${digits} horas`).replace(/ horas $/u, " ")].some((words) =>
      heardWords.includes(words),
    );
  const missing = scriptNumbers(lines).filter((token) => {
    if (heard(digitRuns(token).join("")) || heardWords.includes(wordsOf(token))) return false;
    // A price heard as "329 e 90" or "trezentos e vinte e nove reais e noventa centavos".
    const [whole, fraction] = token.replace(/[^\d,]/gu, "").split(",");
    return !(fraction && whole && heard(whole) && heard(fraction));
  });
  return Object.freeze({
    verdict: missing.length > 0 ? "block" : "pass",
    wer: Math.round(wordErrorRate(lines.join(" "), transcript) * 1000) / 1000,
    missing: Object.freeze(missing),
    model: input.model,
    checkedAt: input.now.toISOString(),
  });
};
