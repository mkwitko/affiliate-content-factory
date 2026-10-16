import type { ChannelKind } from "../channels/channel.js";
import { hasGenericHookOpener } from "../creatives/slide-spec.js";
import type { CreativeFormat } from "./content.js";

/**
 * Deterministic pre-publish checklist (spec INV-L1, INV-L2). It checks structure, measured
 * quality and, through `claimProblems` (claim-verifier), commercial claims the offer facts do not
 * back. A check whose input is absent is "n/a" and leaves the denominator.
 */
export type CheckResult = "pass" | "warn" | "fail" | "n/a";
export type ScoreCheck = Readonly<{
  id: string;
  weight: number;
  result: CheckResult;
  hard: boolean;
  detail?: string;
}>;
export type PrepublishScore = Readonly<{
  version: 2;
  score: number;
  verdict: "pass" | "warn" | "block";
  checks: readonly ScoreCheck[];
}>;
type Verdict = "pass" | "warn" | "block";
export type PrepublishInput = Readonly<{
  format: CreativeFormat;
  channelKind?: ChannelKind;
  durationSec?: number;
  /** First slide headline or first spoken line. */
  hookText?: string;
  hookTiming?: Readonly<{ firstCaptionMs: number; firstSpokenMs: number }>;
  productFirst?: boolean;
  cta?: Readonly<{ expected: string; copy: string }>;
  captionClipped?: boolean;
  /** Shown price or discount claim and the age of the evidence behind it. */
  price?: Readonly<{ shown: boolean; evidenceAgeDays?: number; maxAgeDays: number }>;
  fidelityVerdict?: Verdict;
  renderVerdict?: Verdict;
  /** `copyClaimProblems` of the caption, slides and voice script against the offer facts. */
  claimProblems?: readonly string[];
}>;

// Bump `version` whenever a weight or threshold changes.
const weights = {
  hook_opener: 3,
  hook_timing: 2,
  product_first: 2,
  cta_present: 2,
  caption_legibility: 3,
  duration_band: 1,
  price_fresh: 3,
  fidelity: 3,
  render_qa: 3,
  claims_backed: 3,
} as const;
const hardIds = new Set([
  "hook_opener",
  "caption_legibility",
  "price_fresh",
  "fidelity",
  "render_qa",
  "claims_backed",
]);

const durationBands: Partial<Record<ChannelKind, (seconds: number) => boolean>> = {
  instagram_reels: (seconds) => seconds >= 15 && seconds <= 45,
  youtube: (seconds) => seconds <= 60 || seconds >= 180,
};
const fromVerdict = (verdict: Verdict | undefined): CheckResult =>
  verdict === undefined
    ? "n/a"
    : verdict === "pass"
      ? "pass"
      : verdict === "warn"
        ? "warn"
        : "fail";
const passOrWarn = (ok: boolean): CheckResult => (ok ? "pass" : "warn");

export const scorePrepublish = (input: PrepublishInput): PrepublishScore => {
  const video = input.format !== "carousel";
  const results: Record<keyof typeof weights, CheckResult> = {
    hook_opener:
      input.hookText === undefined ? "n/a" : hasGenericHookOpener(input.hookText) ? "fail" : "pass",
    hook_timing:
      video && input.hookTiming
        ? passOrWarn(
            input.hookTiming.firstCaptionMs <= 300 && input.hookTiming.firstSpokenMs <= 2000,
          )
        : "n/a",
    product_first:
      (input.format === "reel_slides" || input.format === "ai_story") &&
      input.productFirst !== undefined
        ? passOrWarn(input.productFirst)
        : "n/a",
    cta_present: input.cta
      ? passOrWarn(input.cta.copy.toLowerCase().includes(input.cta.expected.toLowerCase()))
      : "n/a",
    caption_legibility:
      video && input.captionClipped !== undefined
        ? input.captionClipped
          ? "fail"
          : "pass"
        : "n/a",
    duration_band: (() => {
      const band = input.channelKind ? durationBands[input.channelKind] : undefined;
      return video && band && input.durationSec !== undefined
        ? passOrWarn(band(input.durationSec))
        : "n/a";
    })(),
    price_fresh:
      input.price?.shown && input.price.evidenceAgeDays !== undefined
        ? input.price.evidenceAgeDays <= input.price.maxAgeDays
          ? "pass"
          : "fail"
        : "n/a",
    fidelity: fromVerdict(input.fidelityVerdict),
    render_qa: video ? fromVerdict(input.renderVerdict) : "n/a",
    claims_backed:
      input.claimProblems === undefined ? "n/a" : input.claimProblems.length ? "fail" : "pass",
  };
  const checks: ScoreCheck[] = (Object.keys(weights) as (keyof typeof weights)[]).map((id) => ({
    id,
    weight: weights[id],
    result: results[id],
    hard: hardIds.has(id),
    ...(id === "claims_backed" && input.claimProblems?.length
      ? { detail: input.claimProblems.slice(0, 3).join(" | ") }
      : {}),
  }));
  const applicable = checks.filter((entry) => entry.result !== "n/a");
  const total = applicable.reduce((sum, entry) => sum + entry.weight, 0);
  const earned = applicable.reduce(
    (sum, entry) =>
      sum +
      (entry.result === "pass" ? entry.weight : entry.result === "warn" ? entry.weight / 2 : 0),
    0,
  );
  const score = total === 0 ? 100 : Math.round((100 * earned) / total);
  const verdict: Verdict = applicable.some((entry) => entry.hard && entry.result === "fail")
    ? "block"
    : score < 60
      ? "warn"
      : "pass";
  return { version: 2, score, verdict, checks };
};
