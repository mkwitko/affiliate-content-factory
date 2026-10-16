import { describe, expect, it } from "vitest";
import { buildNicheStorefront, STOREFRONT_CARD_LIMIT } from "./bio-storefront.js";
import type { NicheStorefrontCandidate } from "./attribution-repository.js";

const candidate = (
  overrides: Partial<NicheStorefrontCandidate> & { offerId: string; publishedAt: Date },
): NicheStorefrontCandidate => ({
  offerTitle: "Offer",
  affiliateUrl: "https://meli.la/offer",
  contentVariantId: `v-${overrides.offerId}`,
  channelKind: "threads",
  assetId: "a1",
  ...overrides,
});

describe("buildNicheStorefront", () => {
  it("dedupes by offer, preferring the instagram_carousel variant over a newer non-carousel one", () => {
    const cards = buildNicheStorefront([
      candidate({
        offerId: "o1",
        channelKind: "threads",
        publishedAt: new Date("2026-09-24T00:00:00Z"),
      }),
      candidate({
        offerId: "o1",
        channelKind: "instagram_carousel",
        publishedAt: new Date("2026-09-20T00:00:00Z"),
      }),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({ offerId: "o1", publishedAt: new Date("2026-09-20T00:00:00Z") }),
    ]);
  });

  it("falls back to the newest variant of any kind when the offer has no instagram_carousel", () => {
    const cards = buildNicheStorefront([
      candidate({
        offerId: "o1",
        channelKind: "threads",
        publishedAt: new Date("2026-09-20T00:00:00Z"),
      }),
      candidate({
        offerId: "o1",
        channelKind: "instagram_stories",
        publishedAt: new Date("2026-09-24T00:00:00Z"),
      }),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({
        offerId: "o1",
        publishedAt: new Date("2026-09-24T00:00:00Z"),
      }),
    ]);
  });

  it("hides an offer whose active snapshot says it is no longer available", () => {
    const cards = buildNicheStorefront([
      candidate({
        offerId: "o1",
        publishedAt: new Date(),
        activeSnapshot: { verifiedAt: new Date(), available: false },
      }),
    ]);
    expect(cards).toEqual([]);
  });

  it("skips a candidate with no asset", () => {
    const cards = buildNicheStorefront([
      {
        offerId: "o1",
        offerTitle: "Offer",
        affiliateUrl: "https://meli.la/offer",
        contentVariantId: "v-o1",
        channelKind: "threads",
        publishedAt: new Date(),
      },
    ]);
    expect(cards).toEqual([]);
  });

  it("orders distinct offers newest first and limits to 30 cards", () => {
    const candidates = Array.from({ length: 35 }, (_, index) =>
      candidate({
        offerId: `o${index}`,
        publishedAt: new Date(2026, 0, index + 1),
      }),
    );
    const cards = buildNicheStorefront(candidates);
    expect(cards).toHaveLength(STOREFRONT_CARD_LIMIT);
    expect(cards[0]?.offerId).toBe("o34");
    expect(cards.at(-1)?.offerId).toBe("o5");
  });

  describe("price", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const brl = (amountMinor: number) => ({ amountMinor, currency: "BRL" });
    const priced = (activeSnapshot: NicheStorefrontCandidate["activeSnapshot"]) =>
      buildNicheStorefront(
        [
          candidate({
            offerId: "o1",
            publishedAt: now,
            ...(activeSnapshot ? { activeSnapshot } : {}),
          }),
        ],
        now,
      )[0];

    it("shows the current and higher list price of a snapshot verified within 24 hours", () => {
      const verifiedAt = new Date("2026-09-23T12:00:01Z");
      expect(
        priced({ verifiedAt, currentPrice: brl(12990), listPrice: brl(15990) })?.price,
      ).toEqual({ current: brl(12990), list: brl(15990), verifiedAt });
    });

    it("drops a list price that is not above the current price", () => {
      const verifiedAt = new Date("2026-09-24T10:00:00Z");
      expect(
        priced({ verifiedAt, currentPrice: brl(12990), listPrice: brl(12990) })?.price,
      ).toEqual({ current: brl(12990), verifiedAt });
      expect(
        priced({
          verifiedAt,
          currentPrice: brl(12990),
          listPrice: { amountMinor: 99999, currency: "USD" },
        })?.price,
      ).toEqual({ current: brl(12990), verifiedAt });
    });

    it("omits the price when the snapshot is older than 24 hours, has no price, or is absent", () => {
      expect(
        priced({ verifiedAt: new Date("2026-09-23T11:59:59Z"), currentPrice: brl(12990) }),
      ).not.toHaveProperty("price");
      expect(
        priced({ verifiedAt: new Date("2026-09-24T10:00:00Z"), listPrice: brl(15990) }),
      ).not.toHaveProperty("price");
      expect(priced(undefined)).not.toHaveProperty("price");
    });
  });
});
