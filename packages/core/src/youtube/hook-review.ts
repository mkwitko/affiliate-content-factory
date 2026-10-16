import type { ScriptBeat } from "../content/editorial.js";
import {
  hasGenericExplainerOpener,
  narrationMsPerWord,
  wordCount,
} from "../explainer/script-guards.js";
import { contentWords, type HookContract, type PackagingVariant } from "./episode-idea.js";

export type HookCheck = Readonly<{ name: string; result: "PASS" | "WARN"; note: string }>;
export type HookReview = Readonly<{ checks: readonly HookCheck[]; mainIssue?: string }>;

/** The packaging promise must be confirmed, and the first loop opened, inside this window. */
const OPENING_SECONDS = 30;
/** Share of the title's content words the opening must repeat. */
const TITLE_COVERAGE = 0.5;

/**
 * Heuristic lint of a script's opening against the approved hook contract and packaging variant.
 * It checks timing and wording only; it does not predict retention, so it has no score.
 */
export const reviewHook = (input: {
  script: Readonly<{ body: string; language: string; beats: readonly ScriptBeat[] }>;
  contract: HookContract;
  variant: Pick<PackagingVariant, "title">;
  forbiddenPhrases: readonly string[];
}): HookReview => {
  const { body, language, beats } = input.script;
  const msPerWord = narrationMsPerWord(language);
  const secondsAt = (char: number) => (wordCount(body.slice(0, char)) * msPerWord) / 1000;
  const opening = (() => {
    const words = Math.floor((OPENING_SECONDS * 1000) / msPerWord);
    const end = [...body.matchAll(/[\p{L}\p{N}']+/gu)][words - 1];
    return end ? body.slice(0, (end.index ?? 0) + end[0].length) : body;
  })();
  const lowerOpening = opening.toLowerCase();
  const beatBy = (kinds: readonly ScriptBeat["kind"][], second: number) =>
    beats.some((b) => kinds.includes(b.kind) && secondsAt(b.atChar) <= second);
  const check = (name: string, ok: boolean, pass: string, warn: string): HookCheck => ({
    name,
    result: ok ? "PASS" : "WARN",
    note: ok ? pass : warn,
  });

  const prohibited = input.contract.prohibitedIntroElements.filter((p) =>
    lowerOpening.includes(p.toLowerCase()),
  );
  const titleWords = contentWords(input.variant.title);
  const openingWords = contentWords(opening);
  const covered = [...titleWords].filter((w) => openingWords.has(w)).length;
  const lowerBody = body.toLowerCase();
  const forbidden = input.forbiddenPhrases.filter((p) => lowerBody.includes(p.toLowerCase()));
  const { proofOrTensionBySecond, firstOpenLoopBySecond, firstPartialPayoffBySecond } =
    input.contract;

  const checks = [
    check(
      "generic_intro",
      !hasGenericExplainerOpener(body, language) && prohibited.length === 0,
      "The opening skips template intros.",
      prohibited.length
        ? `The first ${OPENING_SECONDS} s contain a prohibited intro element: ${prohibited.join(", ")}.`
        : "The script starts with a template opener.",
    ),
    check(
      "title_confirmation",
      titleWords.size === 0 || covered / titleWords.size >= TITLE_COVERAGE,
      "The opening confirms the title.",
      `The first ${OPENING_SECONDS} s repeat only ${covered} of ${titleWords.size} title words; confirm what the title promised.`,
    ),
    check(
      "open_loop",
      beatBy(["open_loop"], firstOpenLoopBySecond),
      "An open loop starts in time.",
      `No open_loop beat starts by second ${firstOpenLoopBySecond}.`,
    ),
    check(
      "first_payoff",
      beatBy(["payoff", "promise", "number_reveal"], firstPartialPayoffBySecond),
      "A first payoff lands in time.",
      `No payoff, promise or number_reveal beat lands by second ${firstPartialPayoffBySecond}.`,
    ),
    check(
      "proof_or_tension",
      beats.some((b) => b.kind !== "hook" && secondsAt(b.atChar) <= proofOrTensionBySecond),
      "Proof or tension arrives in time.",
      `Nothing but the hook lands by second ${proofOrTensionBySecond}; add proof or tension.`,
    ),
    check(
      "forbidden_phrases",
      forbidden.length === 0,
      "No forbidden phrases.",
      `The script uses forbidden phrases: ${forbidden.join(", ")}.`,
    ),
  ];
  const mainIssue = checks.find((c) => c.result === "WARN")?.note;
  return { checks, ...(mainIssue ? { mainIssue } : {}) };
};
