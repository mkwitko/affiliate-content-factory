import { describe, expect, it } from "vitest";
import type { Learning } from "../analytics/learnings.js";
import { type FormatDirectorInput, recommendFormat } from "./format-director.js";

const base: FormatDirectorInput = {
  seed: "item-1",
  nicheId: "n1",
  nicheKind: "affiliate",
  channelKinds: ["instagram_carousel", "instagram_reels"],
  hasProductPhoto: true,
  hasOwnedLongFormSource: false,
  learnings: [],
  recentFormats: [],
  explorationRate: 0,
};
const win = (feature: Learning["feature"], winner: string): Learning => ({
  feature,
  armA: "x",
  armB: winner,
  metric: "shares",
  platform: "instagram",
  checkpoint: "7d",
  nA: 10,
  nB: 10,
  deltaPct: 50,
  winner,
  status: "learning",
  confidence: "directional",
});

describe("recommendFormat", () => {
  it("respects channel kinds, niche kind and assets", () => {
    expect(recommendFormat({ ...base, channelKinds: ["threads"] }).format).toBeNull();
    expect(recommendFormat({ ...base, hasProductPhoto: false }).format).toBeNull();
    expect(recommendFormat({ ...base, channelKinds: ["instagram_carousel"] }).format).toBe(
      "carousel",
    );
    const media = recommendFormat({
      ...base,
      nicheKind: "media",
      channelKinds: ["youtube"],
      hasProductPhoto: false,
    });
    expect(media).toMatchObject({ format: "stickman_explainer", durationSec: 240 });
    expect(
      recommendFormat({
        ...base,
        nicheKind: "media",
        channelKinds: ["youtube"],
        hasOwnedLongFormSource: true,
        allowedFormats: ["owned_clip"],
      }).format,
    ).toBe("owned_clip");
  });
  it("never recommends a format the policy does not allow", () => {
    for (let i = 0; i < 20; i++) {
      const out = recommendFormat({ ...base, seed: `s${i}`, allowedFormats: ["reel_slides"] });
      expect(out.format).toBe("reel_slides");
    }
    expect(
      recommendFormat({
        ...base,
        allowedFormats: ["ai_story"],
        channelKinds: ["instagram_carousel"],
      }).format,
    ).toBeNull();
  });
  it("never recommends the trial ai_story renderer unless the niche opted in", () => {
    const video = { ...base, channelKinds: ["instagram_reels" as const] };
    for (let i = 0; i < 40; i++)
      expect(recommendFormat({ ...video, seed: `t${i}` }).format).not.toBe("ai_story");
    const only = { ...video, allowedFormats: ["ai_story"] };
    expect(recommendFormat(only).format).toBeNull();
    expect(recommendFormat({ ...only, allowTrialRenderers: false }).format).toBeNull();
    const optedIn = recommendFormat({ ...only, allowTrialRenderers: true });
    expect(optedIn).toMatchObject({ format: "ai_story", pipeline: "create_story_assets" });
  });
  it("exploits a winning format and hook move", () => {
    const out = recommendFormat({
      ...base,
      learnings: [win("format", "reel_slides"), win("hookMove", "contrast")],
    });
    expect(out).toMatchObject({ format: "reel_slides", hookMove: "contrast" });
    expect(out.experiment).toBeUndefined();
  });
  it("explores deterministically per item id and declares the arm", () => {
    const explore = { ...base, explorationRate: 1 };
    const first = recommendFormat(explore);
    expect(recommendFormat(explore)).toEqual(first);
    expect(first.experiment).toMatchObject({
      key: expect.stringContaining("n1:"),
      feature: expect.any(String),
    });
    const formats = new Set(
      Array.from({ length: 30 }, (_, i) => recommendFormat({ ...explore, seed: `s${i}` }).format),
    );
    expect(formats.size).toBeGreaterThan(1);
  });
  it("scopes the experiment key to the topic and channel kinds", () => {
    const explore = { ...base, explorationRate: 1 };
    const key = (extra: object) => recommendFormat({ ...explore, ...extra }).experiment?.key;
    expect(key({ topic: "offer-1" })).not.toBe(key({ topic: "offer-2" }));
    expect(key({ channelKinds: ["threads"] })).not.toBe(key({ channelKinds: ["tiktok_video"] }));
  });
  it("explores at about the configured rate", () => {
    const hits = Array.from(
      { length: 400 },
      (_, i) => recommendFormat({ ...base, seed: `s${i}`, explorationRate: 0.25 }).experiment,
    ).filter(Boolean).length;
    expect(hits).toBeGreaterThan(60);
    expect(hits).toBeLessThan(140);
  });
  it("avoids repeating the last 3 format and hook pairs", () => {
    const first = recommendFormat(base);
    const again = recommendFormat({
      ...base,
      recentFormats: [{ format: first.format ?? undefined, hookMove: first.hookMove ?? undefined }],
    });
    expect([again.format, again.hookMove]).not.toEqual([first.format, first.hookMove]);
  });
  it("explains when novelty cannot be met instead of throwing", () => {
    const only = {
      ...base,
      channelKinds: ["instagram_carousel"] as const,
      learnings: [win("hookMove", "contrast")],
    };
    const out = recommendFormat({
      ...only,
      recentFormats: [{ format: "carousel", hookMove: "contrast" }],
    });
    expect(out.format).toBe("carousel");
    expect(out.reasons.join(" ")).toContain("novelty");
  });
});
