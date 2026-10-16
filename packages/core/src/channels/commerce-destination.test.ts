import { describe, expect, it } from "vitest";
import { commerceDestinationFor } from "./commerce-destination.js";

describe("commerceDestinationFor", () => {
  it("gives mercado_livre offers an external link on every non-TikTok channel", () => {
    for (const kind of [
      "instagram_carousel",
      "instagram_stories",
      "instagram_reels",
      "threads",
      "youtube",
    ] as const) {
      expect(commerceDestinationFor(kind, "mercado_livre")).toBe("external_link");
    }
  });

  it("sends mercado_livre offers on tiktok_video through the profile, not the caption", () => {
    expect(commerceDestinationFor("tiktok_video", "mercado_livre")).toBe("profile_link");
  });

  it("gives mercado_livre offers no supported destination on tiktok_photo_post", () => {
    expect(commerceDestinationFor("tiktok_photo_post", "mercado_livre")).toBe("unsupported");
  });

  it("gives tiktok_shop offers manual in-app attachment only on tiktok_video", () => {
    expect(commerceDestinationFor("tiktok_video", "tiktok_shop")).toBe("manual_shop_attachment");
  });

  it("gives tiktok_shop offers no supported destination on any other channel", () => {
    for (const kind of [
      "instagram_carousel",
      "instagram_stories",
      "instagram_reels",
      "threads",
      "youtube",
      "tiktok_photo_post",
    ] as const) {
      expect(commerceDestinationFor(kind, "tiktok_shop")).toBe("unsupported");
    }
  });
});
