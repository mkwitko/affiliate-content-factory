import { describe, expect, it } from "vitest";
import type { BuyerVoice, ProductEvidence } from "../offers/marketplace-catalog.js";
import {
  type DuplicateContext,
  duplicateReason,
  MAX_BEST_SELLER_RANK,
  MIN_REVIEW_COUNT,
  MIN_SOLD_WITHOUT_REVIEWS,
  qualifyCandidate,
} from "./candidate-qualification.js";

const now = new Date("2026-10-02T12:00:00Z");

const evidence = (overrides: Record<string, unknown> = {}): ProductEvidence =>
  ({
    providerId: "MLB1",
    title: "Cafeteira portatil",
    listingUrl: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    seller: "Loja",
    availability: "available",
    listingStatus: "active",
    currentPrice: { amountMinor: 9990, currency: "BRL" },
    soldQuantity: 500,
    availableQuantity: 10,
    freeShipping: true,
    observedAt: now,
    ratingAverage: 4.6,
    reviewCount: 120,
    ...overrides,
  }) as ProductEvidence;

const voice = (overrides: Partial<BuyerVoice> = {}): BuyerVoice => ({
  providerId: "MLB1",
  sourceUrl: new URL("https://www.mercadolivre.com.br/p/MLB1"),
  observedAt: now,
  ratingAverage: 4.6,
  reviewCount: 120,
  positiveReviews: [{ rating: 5, title: "Otima", text: "Funciona muito bem" }],
  negativeReviews: [{ rating: 1, title: "Ruim", text: "x".repeat(400) }],
  questions: [{ question: "Tem garantia?", answer: null }],
  pictures: [],
  unavailable: [],
  ...overrides,
});

const qualify = (input: Partial<Parameters<typeof qualifyCandidate>[0]> = {}) =>
  qualifyCandidate({ evidence: evidence(), voice: null, prioritize: [], now, ...input });

describe("qualifyCandidate rejections", () => {
  it.each([
    ["listing_inactive", { listingStatus: "paused" as const }],
    ["out_of_stock", { availableQuantity: 0 }],
    [
      "evidence_unavailable",
      {
        ratingAverage: undefined,
        reviewCount: undefined,
        soldQuantity: MIN_SOLD_WITHOUT_REVIEWS - 1,
      },
    ],
    ["no_rating", { ratingAverage: undefined }],
    ["no_rating", { reviewCount: 0 }],
    ["too_few_reviews", { reviewCount: MIN_REVIEW_COUNT - 1 }],
  ] as const)("rejects with %s", (reason, overrides) => {
    expect(qualify({ evidence: evidence(overrides) })).toEqual({ kind: "rejected", reason });
  });

  it("qualifies a well-sold product when Mercado Livre withholds reviews, and says so", () => {
    const outcome = qualify({
      evidence: evidence({ ratingAverage: undefined, reviewCount: undefined, soldQuantity: 5000 }),
    });
    expect(outcome).toMatchObject({
      kind: "qualified",
      qualification: {
        facts: { rating: null, reviewCount: null, soldQuantity: 5000 },
        reasons: ["rating unavailable from Mercado Livre", "about 5000 sold", "free shipping"],
      },
    });
  });

  it("qualifies an unrated top-20 best seller and rejects an unrated one below it", () => {
    const unrated = evidence({
      ratingAverage: undefined,
      reviewCount: undefined,
      soldQuantity: undefined,
    });
    expect(qualify({ evidence: unrated, bestSellerRank: 4 })).toMatchObject({
      kind: "qualified",
      qualification: {
        reasons: [
          "rating unavailable from Mercado Livre",
          "best seller #4 in its category",
          "free shipping",
        ],
      },
    });
    expect(qualify({ evidence: unrated, bestSellerRank: MAX_BEST_SELLER_RANK + 1 })).toEqual({
      kind: "rejected",
      reason: "evidence_unavailable",
    });
  });

  it("records brand and category so the queue can stay varied", () => {
    expect(
      qualify({ evidence: evidence({ brand: "Amazon", domainId: "MLB-SMART_SPEAKERS" }) }),
    ).toMatchObject({
      qualification: { facts: { brand: "Amazon", domainId: "MLB-SMART_SPEAKERS" } },
    });
  });

  it("accepts exactly the minimum review count", () => {
    expect(qualify({ evidence: evidence({ reviewCount: MIN_REVIEW_COUNT }) }).kind).toBe(
      "qualified",
    );
  });
});

describe("qualifyCandidate scoring", () => {
  const scoreOf = (outcome: ReturnType<typeof qualify>) => {
    if (outcome.kind !== "qualified") throw new Error("expected qualified");
    return outcome.qualification.heuristic.score;
  };

  it("grows with review count and prioritize matches", () => {
    const few = scoreOf(qualify({ evidence: evidence({ reviewCount: 10 }) }));
    const many = scoreOf(qualify({ evidence: evidence({ reviewCount: 1000 }) }));
    expect(many).toBeGreaterThan(few);
    const matched = scoreOf(qualify({ prioritize: ["cafeteira"] }));
    expect(matched).toBe(Math.round((scoreOf(qualify()) + 5) * 10) / 10);
  });

  it("records the formula parts and facts", () => {
    const outcome = qualify({ prioritize: ["cafeteira", "xyz"] });
    if (outcome.kind !== "qualified") throw new Error("expected qualified");
    expect(outcome.qualification).toMatchObject({
      version: 1,
      facts: {
        rating: 4.6,
        reviewCount: 120,
        soldQuantity: 500,
        listPriceMinor: null,
        freeShipping: true,
        observedAt: now.toISOString(),
      },
      heuristic: { parts: { reviews: expect.any(Number), prioritize: 5 } },
      buyerVoice: null,
    });
  });

  it("truncates buyer excerpts to 160 chars, flags them untrusted and picks the complaint angle", () => {
    const outcome = qualify({ voice: voice() });
    if (outcome.kind !== "qualified") throw new Error("expected qualified");
    const { buyerVoice, hypotheses } = outcome.qualification;
    expect(buyerVoice?.untrusted).toBe(true);
    expect(buyerVoice?.topComplaint?.length).toBe(160);
    expect(buyerVoice?.topPraise).toContain("Funciona muito bem");
    expect(buyerVoice?.firstQuestion).toBe("Tem garantia?");
    expect(hypotheses).toEqual(["angle: buyer complaint addressed"]);
  });

  it("falls back to the demonstration angle without a negative review", () => {
    const outcome = qualify({ voice: voice({ negativeReviews: [] }) });
    if (outcome.kind !== "qualified") throw new Error("expected qualified");
    expect(outcome.qualification.hypotheses).toEqual(["angle: demonstration"]);
  });
});

describe("duplicateReason", () => {
  const ctx = (
    overrides: Partial<Record<keyof DuplicateContext, string[]>> = {},
  ): DuplicateContext => ({
    openProductIds: new Set(overrides.openProductIds ?? []),
    offerProductIds: new Set(overrides.offerProductIds ?? []),
    cooldownProductIds: new Set(overrides.cooldownProductIds ?? []),
  });

  it("returns null for an unseen product", () => {
    expect(duplicateReason("MLB1", ctx())).toBeNull();
  });

  it("prefers pending over offer over cooldown", () => {
    const all = ctx({
      openProductIds: ["MLB1"],
      offerProductIds: ["MLB1"],
      cooldownProductIds: ["MLB1"],
    });
    expect(duplicateReason("MLB1", all)).toBe("already_pending");
    expect(
      duplicateReason("MLB1", ctx({ offerProductIds: ["MLB1"], cooldownProductIds: ["MLB1"] })),
    ).toBe("already_offer");
    expect(duplicateReason("MLB1", ctx({ cooldownProductIds: ["MLB1"] }))).toBe("recently_posted");
  });
});
