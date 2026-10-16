import { describe, expect, it } from "vitest";
import {
  commercialFactsFromTikTokShopObservation,
  type TikTokShopProductObservation,
} from "./commercial-facts.js";

const observation: TikTokShopProductObservation = {
  productId: "tt-prod-1",
  seller: "Loja X",
  currentPrice: { amountMinor: 4990, currency: "BRL" },
  commissionPercent: 15,
  productUrl: "https://www.tiktok.com/shop/product/tt-prod-1",
};

describe("commercialFactsFromTikTokShopObservation", () => {
  it("produces one fact per present field, sourced from the product page", () => {
    const facts = commercialFactsFromTikTokShopObservation(observation);
    expect(facts).toEqual([
      {
        key: "product_id",
        value: "tt-prod-1",
        sourceUrl: observation.productUrl,
        verified: true,
      },
      { key: "seller", value: "Loja X", sourceUrl: observation.productUrl, verified: true },
      {
        key: "current_price",
        value: { amountMinor: 4990, currency: "BRL" },
        sourceUrl: observation.productUrl,
        verified: true,
      },
      {
        key: "commission_percent",
        value: 15,
        sourceUrl: observation.productUrl,
        verified: true,
      },
    ]);
  });

  it("derives discount_percent from list and current price, rounded down", () => {
    const facts = commercialFactsFromTikTokShopObservation({
      ...observation,
      listPrice: { amountMinor: 10000, currency: "BRL" },
    });
    expect(facts).toContainEqual({
      key: "discount_percent",
      value: 50,
      sourceUrl: observation.productUrl,
      verified: true,
    });
  });

  it("omits absent optional fields entirely rather than writing them as null", () => {
    const facts = commercialFactsFromTikTokShopObservation(observation);
    expect(facts.map((fact) => fact.key)).not.toContain("commission_plan");
    expect(facts.map((fact) => fact.key)).not.toContain("sample_available");
    expect(facts.map((fact) => fact.key)).not.toContain("category");
    expect(facts.map((fact) => fact.key)).not.toContain("stock_status");
  });

  it("includes commission plan, sample availability, category, and stock status when given", () => {
    const facts = commercialFactsFromTikTokShopObservation({
      ...observation,
      commissionPlan: "open",
      sampleAvailable: true,
      category: "electronics",
      stockStatus: "in_stock",
    });
    expect(facts).toContainEqual({
      key: "commission_plan",
      value: "open",
      sourceUrl: observation.productUrl,
      verified: true,
    });
    expect(facts).toContainEqual({
      key: "sample_available",
      value: true,
      sourceUrl: observation.productUrl,
      verified: true,
    });
    expect(facts).toContainEqual({
      key: "category",
      value: "electronics",
      sourceUrl: observation.productUrl,
      verified: true,
    });
    expect(facts).toContainEqual({
      key: "stock_status",
      value: "in_stock",
      sourceUrl: observation.productUrl,
      verified: true,
    });
  });
});
