import { describe, expect, it } from "vitest";
import { type ArenaCandidateSummary, paretoFrontier, proposePromotion } from "./promotion.js";

const summary = (over: Partial<ArenaCandidateSummary>): ArenaCandidateSummary => ({
  modelId: "local:flux-2-klein-4b",
  stages: { smoke: "pass", qualification: "pass", full: "pass" },
  latencyP95Ms: 200_000,
  failureRate: 0.05,
  peakVramMb: 7_000,
  criticalRegressions: [],
  ...over,
});

describe("paretoFrontier", () => {
  it("keeps every point no other point beats on all objectives", () => {
    const frontier = paretoFrontier(
      [
        { id: "fast", metrics: { quality: 0.6, latency: 60 } },
        { id: "good", metrics: { quality: 0.8, latency: 200 } },
        { id: "worse", metrics: { quality: 0.55, latency: 210 } },
        { id: "blind", metrics: { latency: 10 } },
      ],
      [
        { key: "quality", goal: "max" },
        { key: "latency", goal: "min" },
      ],
    );
    expect(frontier).toEqual({ frontier: ["fast", "good"], incomplete: ["blind"] });
  });
});

describe("proposePromotion", () => {
  const champion = summary({});
  const challenger = (over: Partial<ArenaCandidateSummary>) =>
    summary({ modelId: "local:z-image-turbo", ...over });

  it("rejects a challenger whose weights are not cleared for commercial use", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({ modelId: "Qwen/Qwen-Image-2.1" }),
      headToHead: { comparisons: 30, winRate: 0.9 },
    });
    expect(p).toMatchObject({ recommendation: "reject", reasons: ["license_blocked"] });
  });

  it("keeps the champion until every stage passed", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({
        stages: { smoke: "pass", qualification: "pass", full: "not_run" },
      }),
      headToHead: { comparisons: 18, winRate: 0.8 },
    });
    expect(p).toMatchObject({ recommendation: "keep", reasons: ["stage_full_not_run"] });
  });

  it("keeps the champion without a clear quality win", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({}),
      headToHead: { comparisons: 30, winRate: 0.52 },
    });
    expect(p.recommendation).toBe("keep");
    expect(p.reasons).toContain("quality_gain_below_threshold");
  });

  it("proposes a quality tier when the winner is much slower", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({ latencyP95Ms: 600_000 }),
      headToHead: { comparisons: 30, winRate: 0.7 },
    });
    expect(p).toMatchObject({ recommendation: "promote_quality_tier", latencyRatio: 3 });
  });

  it("promotes a faster, better, equally reliable challenger", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({ latencyP95Ms: 100_000, failureRate: 0.02 }),
      headToHead: { comparisons: 30, winRate: 0.68 },
    });
    expect(p).toMatchObject({ recommendation: "promote", reasons: [] });
  });

  it("refuses a challenger over the VRAM budget", () => {
    const p = proposePromotion({
      task: "image.character_scene",
      champion,
      challenger: challenger({ peakVramMb: 9_000 }),
      headToHead: { comparisons: 30, winRate: 0.8 },
    });
    expect(p).toMatchObject({ recommendation: "reject", reasons: ["vram_over_budget"] });
  });
});
