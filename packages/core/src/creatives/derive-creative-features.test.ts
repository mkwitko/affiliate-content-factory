import { describe, expect, it } from "vitest";
import type { CreativeDocument } from "./creative-document.js";
import { deriveCreativeFeatures } from "./derive-creative-features.js";
import type { PriceDisplay } from "./price-display.js";
import type { SlideSpec } from "./slide-spec.js";

const slide = (overrides: Partial<SlideSpec> = {}): SlideSpec => ({
  index: 1,
  total: 1,
  template: "hero",
  headline: "Short one",
  claims: [],
  ...overrides,
});
const price = (extra: Partial<PriceDisplay> = {}): PriceDisplay => ({
  current: { amountMinor: 100, currency: "BRL" },
  source: { factKeys: ["current_price"], snapshotId: "s", verifiedAt: "2026-01-01" },
  ...extra,
});

describe("deriveCreativeFeatures", () => {
  it("derives copy features and never invents operator judgements", () => {
    const derived = deriveCreativeFeatures({
      channelKind: "instagram_carousel",
      slides: [
        slide({
          badge: "R$ 1",
          headline: "x".repeat(30),
          claims: [{ text: "4,8", factKey: "rating_average" }],
        }),
      ],
      price: price({ discountPct: 20 }),
    });
    expect(derived).toEqual({
      format: "carousel",
      priceShown: true,
      discountShown: true,
      ratingShown: true,
      headlineLength: "medium",
    });
  });

  it("shows no price without a badge or a verified price, and maps reels", () => {
    expect(
      deriveCreativeFeatures({ channelKind: "instagram_reels", slides: [slide()], price: price() }),
    ).toMatchObject({ format: "reel_slides", priceShown: false, discountShown: false });
    expect(
      deriveCreativeFeatures({ slides: [slide({ badge: "R$ 1" })], price: null }),
    ).toMatchObject({ priceShown: false });
  });

  it("reads layout family, product mode and CTA kind from stored documents", () => {
    const document = (cta?: CreativeDocument["cta"]) =>
      ({
        layoutFamily: "character_product",
        layers: { product: { mode: "in_scene" } },
        ...(cta ? { cta } : {}),
      }) as unknown as CreativeDocument;
    expect(
      deriveCreativeFeatures({
        slides: [slide()],
        price: null,
        documents: [document(), document({ kind: "link_in_bio", text: "Link na bio" })],
      }),
    ).toMatchObject({
      layoutFamily: "character_product",
      productMode: "in_scene",
      ctaKind: "link_in_bio",
      headlineLength: "short",
    });
  });
});
