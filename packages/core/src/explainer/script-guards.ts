import type { Claim, ScriptBeat } from "../content/editorial.js";
import { isHookType, type HookType } from "./hook-library.js";

/**
 * Deterministic gates for media-niche scripts. They block only what is objectively detectable
 * (template openers, wrong length, no hook type, no payoff, no verified fact); the subjective
 * anti-slop review stays with the operator skill and the editorial review.
 */
const WORDS_PER_MINUTE: Readonly<Record<string, number>> = { en: 165, pt: 155, es: 160 };
const DEFAULT_WORDS_PER_MINUTE = 160;
/** A hook must start within the first ~2 seconds of narration. */
const HOOK_MAX_CHAR = 120;
const OPENER_WINDOW_CHARS = 80;

const openers: Readonly<Record<string, readonly string[]>> = {
  en: [
    "did you know",
    "today we're going to",
    "today we are going to",
    "in this video",
    "have you ever wondered",
    "welcome back",
  ],
  pt: [
    "voce sabia",
    "hoje vamos",
    "neste video",
    "nesse video",
    "ja se perguntou",
    "bem vindo de volta",
  ],
  es: ["sabias que", "hoy vamos", "en este video", "alguna vez te has preguntado"],
};

const languageKey = (language: string): string => language.slice(0, 2).toLowerCase();
const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
export const wordCount = (body: string): number => (body.match(/[\p{L}\p{N}']+/gu) ?? []).length;

/** Average narration time per word for a language, ms (from the same words-per-minute table). */
export const narrationMsPerWord = (language: string): number =>
  60_000 / (WORDS_PER_MINUTE[languageKey(language)] ?? DEFAULT_WORDS_PER_MINUTE);

export const estimateNarrationSeconds = (body: string, language: string): number =>
  Math.round(
    (wordCount(body) / (WORDS_PER_MINUTE[languageKey(language)] ?? DEFAULT_WORDS_PER_MINUTE)) * 60,
  );

export const hasGenericExplainerOpener = (body: string, language: string): boolean => {
  const head = normalize(body).slice(0, OPENER_WINDOW_CHARS);
  return (openers[languageKey(language)] ?? []).some((opener) => head.startsWith(opener));
};

export type ExplainerScriptRejection =
  | "generic_opener"
  | "too_short"
  | "too_long"
  | "hook_type_missing"
  | "hook_beat_missing"
  | "payoff_beat_missing"
  | "no_verified_fact";
export type ExplainerScriptVerdict =
  | Readonly<{ ok: true; estimatedSeconds: number; hookType: HookType }>
  | Readonly<{ ok: false; reason: ExplainerScriptRejection; estimatedSeconds: number }>;

export const validateExplainerScript = (input: {
  body: string;
  language: string;
  claims: readonly Claim[];
  beats: readonly ScriptBeat[];
  targetSeconds: Readonly<{ min: number; max: number }>;
}): ExplainerScriptVerdict => {
  const estimatedSeconds = estimateNarrationSeconds(input.body, input.language);
  const fail = (reason: ExplainerScriptRejection): ExplainerScriptVerdict => ({
    ok: false,
    reason,
    estimatedSeconds,
  });
  if (hasGenericExplainerOpener(input.body, input.language)) return fail("generic_opener");
  if (estimatedSeconds < input.targetSeconds.min) return fail("too_short");
  if (estimatedSeconds > input.targetSeconds.max) return fail("too_long");
  const hook = input.beats.find((beat) => beat.kind === "hook" && beat.atChar <= HOOK_MAX_CHAR);
  if (!hook) return fail("hook_beat_missing");
  if (!isHookType(hook.label)) return fail("hook_type_missing");
  if (!input.beats.some((beat) => beat.kind === "payoff")) return fail("payoff_beat_missing");
  if (!input.claims.some((claim) => claim.kind === "verified_fact"))
    return fail("no_verified_fact");
  return { ok: true, estimatedSeconds, hookType: hook.label };
};
