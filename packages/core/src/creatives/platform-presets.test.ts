import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  PLATFORM_PRESETS,
  pillLabelColour,
  presetForChannelKind,
  showCounter,
  uiFreeRows,
} from "./platform-presets.js";

describe("platform presets", () => {
  it("maps image channel kinds and ignores video kinds", () => {
    expect(presetForChannelKind("instagram_carousel")?.id).toBe("instagram_feed");
    expect(presetForChannelKind("instagram_stories")?.canvas).toEqual({ w: 1080, h: 1920 });
    expect(presetForChannelKind("tiktok_photo_post")?.id).toBe("tiktok_photo");
    expect(presetForChannelKind("threads")?.canvas).toEqual({ w: 1080, h: 1350 });
    expect(presetForChannelKind("youtube")).toBeNull();
    expect(presetForChannelKind("instagram_reels")).toBeNull();
  });
  it("draws the counter only for carousels with more than one image", () => {
    const feed = PLATFORM_PRESETS.instagram_feed;
    expect(showCounter(feed, 1)).toBe(false);
    expect(showCounter(feed, 5)).toBe(true);
    expect(showCounter(PLATFORM_PRESETS.threads, 5)).toBe(false);
  });
  it("marks the Instagram keyword CTA as manual and keeps links out of TikTok captions", () => {
    expect(PLATFORM_PRESETS.instagram_feed.cta.default).toBe("link_in_bio");
    expect(PLATFORM_PRESETS.instagram_feed.cta.requiresWorkflow?.comment_keyword).toBe(
      "manual_dm_reply",
    );
    expect(PLATFORM_PRESETS.tiktok_photo.cta.default).toBe("link_in_bio");
    expect(PLATFORM_PRESETS.tiktok_photo.cta.allowed).not.toContain("comment_keyword");
  });
  it("reserves the story UI rows", () => {
    expect(uiFreeRows(PLATFORM_PRESETS.instagram_story, 1920)).toEqual({ top: 269, bottom: 1536 });
    expect(uiFreeRows(PLATFORM_PRESETS.instagram_feed, 1350)).toEqual({ top: 0, bottom: 1350 });
  });
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("pillLabelColour", () => {
  it("keeps white on a dark fill and switches to the dark ink on the light cyan accent", () => {
    expect(pillLabelColour("#1E3A8A", "#0F172A")).toBe("#ffffff");
    expect(pillLabelColour("#22D3EE", "#0F172A")).toBe("#0F172A");
    expect(contrastRatio(pillLabelColour("#22D3EE", "#0F172A"), "#22D3EE")).toBeGreaterThan(4.5);
  });
});
