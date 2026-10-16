import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { CommercialFact, CommercialSnapshot, Offer } from "./offer.js";
import { analyzeOfferPriceHistory } from "./price-intelligence.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-01T12:00:00Z");

const snapshot = (
  daysAgo: number,
  overrides: Readonly<{
    price?: number;
    currency?: string;
    seller?: string;
    availability?: string | boolean | null;
    listPrice?: number;
    variationId?: string;
  }> = {},
): CommercialSnapshot => {
  const facts: CommercialFact[] = [
    {
      key: "current_price",
      value: { amountMinor: overrides.price ?? 10000, currency: overrides.currency ?? "BRL" },
      sourceUrl: "https://www.mercadolivre.com.br/item",
      verified: true,
    },
    {
      key: "seller",
      value: overrides.seller ?? "Loja A",
      sourceUrl: "https://www.mercadolivre.com.br/item",
      verified: true,
    },
  ];
  const available = overrides.availability === undefined ? "available" : overrides.availability;
  if (available !== null)
    facts.push({
      key: "availability",
      value: available,
      sourceUrl: "https://www.mercadolivre.com.br/item",
      verified: true,
    });
  if (overrides.listPrice !== undefined)
    facts.push({
      key: "list_price",
      value: { amountMinor: overrides.listPrice, currency: overrides.currency ?? "BRL" },
      sourceUrl: "https://www.mercadolivre.com.br/item",
      verified: true,
    });
  if (overrides.variationId)
    facts.push({
      key: "variation_id",
      value: overrides.variationId,
      sourceUrl: "https://www.mercadolivre.com.br/item",
      verified: true,
    });
  return {
    id: `snapshot-${daysAgo}-${overrides.price ?? 10000}`,
    verifiedAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    facts,
  };
};

const offer = (snapshots: readonly CommercialSnapshot[]): Offer => ({
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/item",
  title: "Item",
  state: "active",
  snapshots,
});

const fullHistory = (
  latest: CommercialSnapshot = snapshot(0.04, { price: 8000, listPrice: 20000 }),
) => [snapshot(8), snapshot(6), snapshot(4), snapshot(2), latest];

describe("analyzeOfferPriceHistory", () => {
  it("separates advertised discount from a price below observed history", () => {
    const result = analyzeOfferPriceHistory({ offer: offer(fullHistory()), now });
    expect(result).toMatchObject({
      isRealDeal: true,
      reason: "below_historical_average",
      sampleCount30d: 5,
      observedMin90d: { amountMinor: 8000, currency: "BRL" },
      observedMax90d: { amountMinor: 10000, currency: "BRL" },
      advertisedDiscountBps: 6000,
    });
  });

  it("does not call an inflated list price a deal after a price rebound", () => {
    const result = analyzeOfferPriceHistory({
      offer: offer(fullHistory(snapshot(0.04, { price: 12000, listPrice: 30000 }))),
      now,
    });
    expect(result).toMatchObject({ isRealDeal: false, reason: "not_below_historical_average" });
    expect(result.advertisedDiscountBps).toBe(6000);
  });

  it("uses TikTok Shop's existing 24-hour manual snapshot policy and stock status", () => {
    const snapshots = fullHistory(snapshot(0.5, { price: 8000 })).map((entry) => ({
      ...entry,
      facts: [
        ...entry.facts.filter((fact) => fact.key !== "availability"),
        {
          key: "stock_status",
          value: "in_stock",
          sourceUrl: "https://www.tiktok.com/view/product/123",
          verified: true,
        },
      ],
    }));
    const result = analyzeOfferPriceHistory({
      offer: {
        ...offer(snapshots),
        marketplace: "tiktok_shop",
        externalProductId: "123",
        listingUrl: "https://www.tiktok.com/view/product/123",
      },
      now,
    });
    expect(result).toMatchObject({ isRealDeal: true, sampleCount30d: 5 });
    expect(result.comparableRule).toContain("24 hours");
  });

  it("keeps sparse history unknown", () => {
    const result = analyzeOfferPriceHistory({ offer: offer([snapshot(1), snapshot(0.04)]), now });
    expect(result).toMatchObject({ isRealDeal: null, reason: "insufficient_history" });
  });

  it("does not aggregate history when the current seller identity is missing", () => {
    const latest = snapshot(0.04, { price: 8000, listPrice: 20000 });
    const result = analyzeOfferPriceHistory({
      offer: offer([
        ...fullHistory().slice(0, -1),
        { ...latest, facts: latest.facts.filter((fact) => fact.key !== "seller") },
      ]),
      now,
    });
    expect(result).toMatchObject({
      isRealDeal: null,
      reason: "seller_unverified",
      sampleCount30d: 0,
    });
  });

  it.each([
    ["stale", [snapshot(10), snapshot(8), snapshot(6), snapshot(4), snapshot(0.5)]],
    ["availability", fullHistory(snapshot(0.04, { availability: false }))],
    ["unverified availability", fullHistory(snapshot(0.04, { availability: null }))],
    [
      "currency",
      [snapshot(8), snapshot(6), snapshot(4), snapshot(2), snapshot(0.04, { currency: "USD" })],
    ],
    ["seller", [snapshot(8, { seller: "Loja antiga" }), ...fullHistory().slice(1)]],
    ["variation", [snapshot(8, { variationId: "red" }), ...fullHistory().slice(1)]],
  ])("returns unknown for %s evidence", (_case, snapshots) => {
    const result = analyzeOfferPriceHistory({ offer: offer(snapshots), now });
    expect(result.isRealDeal).toBeNull();
  });
});
