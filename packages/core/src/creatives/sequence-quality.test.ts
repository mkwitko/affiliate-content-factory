import { describe, expect, it } from "vitest";
import { judgeCarouselSequence, type SequenceSlide } from "./sequence-quality.js";

const deck: SequenceSlide[] = [
  { index: 1, template: "hero", headline: "Banheiro em ordem", sceneAssetId: "s1" },
  { index: 2, template: "benefit", headline: "Cabe tudo", sceneAssetId: "s2" },
  { index: 3, template: "proof", headline: "Quem comprou aprovou", sceneAssetId: "s3" },
  { index: 4, template: "price", headline: "Preço", sceneAssetId: null },
  { index: 5, template: "cta", headline: "Garanta o seu", sceneAssetId: "s5" },
];

describe("judgeCarouselSequence", () => {
  it("passes a varied deck with the hook first and the CTA last", () => {
    expect(judgeCarouselSequence(deck)).toMatchObject({ verdict: "pass", reasons: [] });
  });

  it("blocks the same scene twice (three identical slides, 2026-10-09)", () => {
    const report = judgeCarouselSequence(
      deck.map((slide) => (slide.index === 3 ? { ...slide, sceneAssetId: "s2" } : slide)),
    );
    expect(report).toMatchObject({ verdict: "block", reasons: ["duplicate_scene:2,3"] });
  });

  it("warns on a repeated headline, a cover that is not the hook, a CTA not last, same framing", () => {
    const report = judgeCarouselSequence([
      { index: 1, template: "benefit", headline: "Cabe tudo", sceneAssetId: "a" },
      { index: 2, template: "benefit", headline: "cabe TUDO!", sceneAssetId: "b" },
      { index: 3, template: "benefit", headline: "Outro", sceneAssetId: "c" },
      { index: 4, template: "cta", headline: "Garanta", sceneAssetId: "d" },
      { index: 5, template: "price", headline: "Preço", sceneAssetId: null },
    ]);
    expect(report.verdict).toBe("warn");
    expect(report.reasons).toEqual([
      "duplicate_headline:1,2",
      "cover_not_hero:benefit",
      "cta_not_last:4",
      "same_framing_run:1-3",
    ]);
  });
});
