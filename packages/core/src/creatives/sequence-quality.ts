import type { QualityVerdict } from "./slide-quality.js";
import type { TemplateId } from "./templates.js";

/**
 * QA of the whole carousel, next to the per-slide QA (brief 14: a set of good images is not a
 * good carousel). Deterministic, from the rendered slides' records: the same scene twice, the
 * same copy twice, a cover that is not the hook, a CTA that is not last, three slides in a row
 * with the same framing. Only a repeated scene blocks (owner review 2026-10-09: three identical
 * slides in one package); the rest warns for the reviewer.
 */
export const SEQUENCE_QUALITY_VERSION = "sequence-quality-v1";

export type SequenceSlide = Readonly<{
  index: number;
  template: TemplateId;
  headline: string;
  /** The scene asset behind the slide; null for cut-out and procedural renders. */
  sceneAssetId: string | null;
}>;
export type SequenceQualityReport = Readonly<{
  version: typeof SEQUENCE_QUALITY_VERSION;
  verdict: QualityVerdict;
  reasons: readonly string[];
}>;

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const judgeCarouselSequence = (slides: readonly SequenceSlide[]): SequenceQualityReport => {
  const ordered = [...slides].sort((a, b) => a.index - b.index);
  const block: string[] = [];
  const warn: string[] = [];
  const scenes = new Map<string, number>();
  const headlines = new Map<string, number>();
  for (const slide of ordered) {
    if (slide.sceneAssetId) {
      const seen = scenes.get(slide.sceneAssetId);
      if (seen !== undefined) block.push(`duplicate_scene:${seen},${slide.index}`);
      else scenes.set(slide.sceneAssetId, slide.index);
    }
    const key = norm(slide.headline);
    const seen = headlines.get(key);
    if (key && seen !== undefined) warn.push(`duplicate_headline:${seen},${slide.index}`);
    else if (key) headlines.set(key, slide.index);
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first && first.template !== "hero") warn.push(`cover_not_hero:${first.template}`);
  const cta = ordered.find((slide) => slide.template === "cta");
  if (cta && last && cta.index !== last.index) warn.push(`cta_not_last:${cta.index}`);
  for (let i = 2; i < ordered.length; i += 1) {
    const [a, b, c] = [ordered[i - 2], ordered[i - 1], ordered[i]];
    if (a && b && c && a.template === b.template && b.template === c.template) {
      warn.push(`same_framing_run:${a.index}-${c.index}`);
      break;
    }
  }
  return {
    version: SEQUENCE_QUALITY_VERSION,
    verdict: block.length ? "block" : warn.length ? "warn" : "pass",
    reasons: [...block, ...warn],
  };
};
