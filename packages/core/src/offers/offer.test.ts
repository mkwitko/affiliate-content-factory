import { describe, expect, it } from "vitest";
import { isMercadoLivreAffiliateUrl } from "./offer.js";

describe("isMercadoLivreAffiliateUrl", () => {
  it("accepts Mercado Livre affiliate hosts only over HTTPS", () => {
    expect(isMercadoLivreAffiliateUrl(new URL("https://meli.la/2AbC"))).toBe(true);
    expect(isMercadoLivreAffiliateUrl(new URL("https://www.mercadolivre.com.br/social/x"))).toBe(
      true,
    );
    expect(isMercadoLivreAffiliateUrl(new URL("https://bit.ly/x"))).toBe(false);
    expect(isMercadoLivreAffiliateUrl(new URL("http://meli.la/x"))).toBe(false);
  });
});
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  activateOffer,
  addEvidenceSnapshot,
  addRefreshedSnapshot,
  createOffer,
  offerDestination,
  productIdFromOffer,
  type CommercialSnapshot,
} from "./offer.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const verifiedAt = new Date("2026-09-20T12:00:00.000Z");
const now = new Date("2026-09-21T12:00:00.000Z");

const snapshot = (overrides: Partial<CommercialSnapshot> = {}): CommercialSnapshot => ({
  id: "snapshot-1",
  verifiedAt,
  facts: [
    {
      key: "seller",
      value: "Example seller",
      sourceUrl: "https://mercadolivre.example/item/1",
      verified: true,
    },
    {
      key: "availability",
      value: "in_stock",
      sourceUrl: "https://mercadolivre.example/item/1",
      verified: true,
    },
    {
      key: "current_price",
      value: { amountMinor: 12990, currency: "BRL" },
      sourceUrl: "https://mercadolivre.example/item/1",
      verified: true,
    },
  ],
  ...overrides,
});

const offer = () =>
  createOffer({
    id: "offer-1",
    workspaceId,
    marketplace: "mercado_livre",
    listingUrl: "https://mercadolivre.example/item/1",
    title: "Example product",
  });

describe("offer domain", () => {
  it("rejects fractional minor units instead of silently losing money precision", () => {
    expect(() =>
      createOffer({
        id: "offer-1",
        workspaceId,
        marketplace: "mercado_livre",
        listingUrl: "https://mercadolivre.example/item/1",
        title: "Example product",
        listPrice: { amountMinor: 129.9, currency: "BRL" },
      }),
    ).toThrow("Money amount must be an integer");
  });

  it("requires an affiliate URL before activation", () => {
    const withEvidence = addEvidenceSnapshot(offer(), snapshot());

    expect(() => activateOffer(withEvidence, now)).toThrow("Affiliate URL is required");
  });

  it("blocks conflicting commercial evidence", () => {
    const withEvidence = addEvidenceSnapshot(offer(), snapshot());
    const conflicting = snapshot({
      id: "snapshot-2",
      facts: snapshot().facts.map((fact) =>
        fact.key === "current_price"
          ? { ...fact, value: { amountMinor: 13990, currency: "BRL" } }
          : fact,
      ),
    });

    expect(() => addEvidenceSnapshot(withEvidence, conflicting)).toThrow(
      "Commercial evidence conflicts",
    );
  });

  it("blocks activation when evidence is stale or unverified", () => {
    const stale = addEvidenceSnapshot(
      createOffer({
        id: "offer-2",
        workspaceId,
        marketplace: "mercado_livre",
        listingUrl: "https://mercadolivre.example/item/2",
        affiliateUrl: "https://affiliate.example/item/2",
        title: "Stale product",
      }),
      snapshot({ verifiedAt: new Date("2026-09-01T12:00:00.000Z") }),
    );
    expect(() => activateOffer(stale, now)).toThrow("Commercial evidence is stale");

    const unverified = addEvidenceSnapshot(
      createOffer({
        id: "offer-3",
        workspaceId,
        marketplace: "mercado_livre",
        listingUrl: "https://mercadolivre.example/item/3",
        affiliateUrl: "https://affiliate.example/item/3",
        title: "Unverified product",
      }),
      snapshot({
        facts: snapshot().facts.map((fact) => ({ ...fact, verified: fact.key !== "seller" })),
      }),
    );
    expect(() => activateOffer(unverified, now)).toThrow("Commercial evidence is unverified");
  });

  it("activates with a verified snapshot and preserves immutable evidence history", () => {
    const draft = addEvidenceSnapshot(
      createOffer({
        id: "offer-4",
        workspaceId,
        marketplace: "mercado_livre",
        listingUrl: "https://mercadolivre.example/item/4",
        affiliateUrl: "https://affiliate.example/item/4",
        title: "Verified product",
      }),
      snapshot(),
    );

    const active = activateOffer(draft, now);

    expect(active.state).toBe("active");
    expect(active.activeSnapshotId).toBe("snapshot-1");
    expect(active.snapshots).toHaveLength(1);
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.snapshots)).toBe(true);
  });

  describe("addRefreshedSnapshot", () => {
    it("accepts a changed volatile fact (price) that addEvidenceSnapshot would reject", () => {
      const withEvidence = addEvidenceSnapshot(offer(), snapshot());
      const refreshed = snapshot({
        id: "snapshot-2",
        verifiedAt: new Date("2026-09-22T12:00:00.000Z"),
        facts: snapshot().facts.map((fact) =>
          fact.key === "current_price"
            ? { ...fact, value: { amountMinor: 13990, currency: "BRL" } }
            : fact,
        ),
      });

      const result = addRefreshedSnapshot(withEvidence, refreshed);

      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots.at(-1)).toMatchObject({ id: "snapshot-2" });
    });

    it("accepts a sold count that grew since the last snapshot", () => {
      const base = snapshot({
        facts: [
          ...snapshot().facts,
          { key: "sold_quantity", value: 8000, sourceUrl: "https://example.com", verified: true },
        ],
      });
      const withEvidence = addEvidenceSnapshot(offer(), base);
      const refreshed = snapshot({
        id: "snapshot-2",
        facts: base.facts.map((fact) =>
          fact.key === "sold_quantity" ? { ...fact, value: 8500 } : fact,
        ),
      });

      expect(addRefreshedSnapshot(withEvidence, refreshed).snapshots).toHaveLength(2);
    });

    it("still blocks a conflict on an identity fact (seller)", () => {
      const withEvidence = addEvidenceSnapshot(offer(), snapshot());
      const refreshed = snapshot({
        id: "snapshot-2",
        facts: snapshot().facts.map((fact) =>
          fact.key === "seller" ? { ...fact, value: "Different seller" } : fact,
        ),
      });

      expect(() => addRefreshedSnapshot(withEvidence, refreshed)).toThrow(
        "Commercial evidence conflicts",
      );
    });
  });

  describe("tiktok_shop offers", () => {
    const tiktokShopOffer = (overrides: Partial<Parameters<typeof createOffer>[0]> = {}) =>
      createOffer({
        id: "offer-tt-1",
        workspaceId,
        marketplace: "tiktok_shop",
        listingUrl: "https://www.tiktok.com/shop/product/123",
        externalProductId: "abc-123",
        title: "TikTok product",
        ...overrides,
      });

    it("requires a valid externalProductId", () => {
      expect(() => tiktokShopOffer({ externalProductId: undefined as unknown as string })).toThrow(
        "TikTok Shop external product id is required",
      );
      expect(() => tiktokShopOffer({ externalProductId: "has a space" })).toThrow(
        "TikTok Shop external product id is required",
      );
    });

    it("forbids an affiliate URL", () => {
      expect(() => tiktokShopOffer({ affiliateUrl: "https://example.com/x" })).toThrow(
        "TikTok Shop offers have no affiliate URL",
      );
    });

    it("requires an https tiktok.com listing URL", () => {
      expect(() => tiktokShopOffer({ listingUrl: "https://example.com/product/123" })).toThrow(
        "TikTok Shop listing URL must be an HTTPS tiktok.com product page",
      );
    });

    it("rejects externalProductId on a mercado_livre offer", () => {
      expect(() =>
        createOffer({
          id: "offer-1",
          workspaceId,
          marketplace: "mercado_livre",
          listingUrl: "https://mercadolivre.example/item/1",
          externalProductId: "abc-123",
          title: "Example product",
        }),
      ).toThrow("externalProductId is only valid for tiktok_shop offers");
    });

    it("activates without an affiliate URL when seller, current_price, and commission_percent are verified", () => {
      const withEvidence = addEvidenceSnapshot(tiktokShopOffer(), {
        id: "snapshot-tt-1",
        verifiedAt: now,
        facts: [
          {
            key: "seller",
            value: "Loja X",
            sourceUrl: "https://www.tiktok.com/shop/product/123",
            verified: true,
          },
          {
            key: "current_price",
            value: { amountMinor: 4990, currency: "BRL" },
            sourceUrl: "https://www.tiktok.com/shop/product/123",
            verified: true,
          },
          {
            key: "commission_percent",
            value: 15,
            sourceUrl: "https://www.tiktok.com/shop/product/123",
            verified: true,
          },
        ],
      });

      const active = activateOffer(withEvidence, now);
      expect(active.state).toBe("active");
    });

    it("requires commission_percent evidence to activate", () => {
      const withEvidence = addEvidenceSnapshot(tiktokShopOffer(), {
        id: "snapshot-tt-2",
        verifiedAt: now,
        facts: [
          {
            key: "seller",
            value: "Loja X",
            sourceUrl: "https://www.tiktok.com/shop/product/123",
            verified: true,
          },
          {
            key: "current_price",
            value: { amountMinor: 4990, currency: "BRL" },
            sourceUrl: "https://www.tiktok.com/shop/product/123",
            verified: true,
          },
        ],
      });

      expect(() => activateOffer(withEvidence, now)).toThrow(
        "Required commercial evidence is missing",
      );
    });
  });

  describe("offerDestination", () => {
    it("returns the affiliate URL for mercado_livre", () => {
      expect(
        offerDestination({
          marketplace: "mercado_livre",
          affiliateUrl: "https://meli.la/abc",
        }),
      ).toBe("https://meli.la/abc");
      expect(offerDestination({ marketplace: "mercado_livre" })).toBeNull();
    });

    it("returns the in-app attachment token for tiktok_shop", () => {
      expect(offerDestination({ marketplace: "tiktok_shop", externalProductId: "abc-123" })).toBe(
        "tiktokshop:product/abc-123",
      );
      expect(offerDestination({ marketplace: "tiktok_shop" })).toBeNull();
    });
  });

  describe("productIdFromOffer", () => {
    it("reads the Mercado Livre product id from the listing URL", () => {
      expect(
        productIdFromOffer({
          listingUrl: "https://www.mercadolivre.com.br/suporte/p/MLB777",
          snapshots: [],
        }),
      ).toBe("MLB777");
    });

    it("returns null when neither the URL nor any snapshot id names a product", () => {
      expect(
        productIdFromOffer({ listingUrl: "https://example.com/item/1", snapshots: [] }),
      ).toBeNull();
    });
  });
});
