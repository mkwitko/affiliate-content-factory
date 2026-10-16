import { describe, expect, it } from "vitest";
import { summarizeCreativePatterns } from "./creative-intelligence.js";

const post = (overrides: Record<string, unknown> = {}) => ({
  channelId: "instagram-1",
  publishedAt: new Date("2026-09-28T12:00:00Z"),
  observedAt: new Date("2026-09-29T12:00:00Z"),
  creativeFeatures: {
    hookMove: "contrast",
    angle: "organização",
    proofType: "buyer_quote",
    urgency: "none",
    priceShown: true,
    discountShown: false,
    ratingShown: false,
  },
  clicks: 8,
  uniqueClicks: 6,
  clickRate: 0.03,
  metrics: { reach: 200 },
  ...overrides,
});

describe("summarizeCreativePatterns", () => {
  it("groups descriptive click evidence by channel, creative feature, and post age", () => {
    const summary = summarizeCreativePatterns([post(), post({ uniqueClicks: 4, clickRate: null })]);

    expect(summary).toContainEqual({
      channelId: "instagram-1",
      metricAgeDays: 1,
      feature: "hookMove",
      value: "contrast",
      sampleCount: 2,
      sufficiency: "insufficient_data",
      clicks: 16,
      uniqueClicks: 10,
      clickRateSamples: 1,
      averageClickRate: 0.03,
    });
  });

  it("excludes invalid feature records and unpublished or future observations", () => {
    const summary = summarizeCreativePatterns([
      post({ creativeFeatures: { hookMove: "invented" } }),
      post({ publishedAt: null }),
      post({ publishedAt: new Date("2026-10-02T12:00:00Z") }),
    ]);
    expect(summary).toEqual([]);
  });
});
