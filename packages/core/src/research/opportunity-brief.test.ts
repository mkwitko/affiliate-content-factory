import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Offer } from "../offers/offer.js";
import type { OfferPriceIntelligence } from "../offers/price-intelligence.js";
import type { BuyerVoiceSummary } from "../offers/buyer-voice.js";
import type { MarketRadarCandidate } from "./market-radar.js";
import { buildOpportunityBrief } from "./opportunity-brief.js";

const offer: Offer = {
  id: "offer-1",
  workspaceId: parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d"),
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB123",
  affiliateUrl: "https://meli.la/abc",
  title: "Organizador compacto",
  state: "active",
  snapshots: [],
};

const price = {
  offerId: offer.id,
  marketplace: offer.marketplace,
  currentObservedPrice: { amountMinor: 10000, currency: "BRL" },
  advertisedListPrice: null,
  advertisedDiscountBps: null,
  observedMin90d: null,
  observedMax90d: null,
  observedMin90dSample: null,
  observedMax90dSample: null,
  average30d: null,
  sampleCount30d: 1,
  sampleCount90d: 1,
  observedFrom: new Date("2026-09-20T00:00:00Z"),
  observedTo: new Date("2026-10-01T00:00:00Z"),
  sampledPrices: [],
  sampledPricesTruncated: 0,
  discountVsAverageBps: null,
  discountVsHistoricalHighBps: null,
  isRealDeal: null,
  reason: "insufficient_history",
  comparableRule: "same product",
} satisfies OfferPriceIntelligence;

const voice = {
  method: "exact_normalized_text_v1",
  sourceUrl: "https://www.mercadolivre.com.br/p/MLB123",
  observedAt: "2026-10-01T12:00:00.000Z",
  sampledReviews: 4,
  uniqueReviews: 3,
  duplicateReviews: 1,
  sampledQuestions: 1,
  uniqueQuestions: 1,
  duplicateQuestions: 0,
  positiveReviewCount: 2,
  negativeReviewCount: 1,
  questionCount: 1,
  unavailable: [],
  evidence: [],
} satisfies BuyerVoiceSummary;

const radar = {
  keyword: "organizador de geladeira",
  rank: 2,
  rankGroup: "fastest_growth",
  confidence: "corroborated",
  sourceCount: 2,
  demandValidated: false,
  growth7d: null,
  growth30d: null,
  growth90d: null,
  observedAt: new Date("2026-10-01T12:00:00Z"),
  evidence: [],
  missingSources: [],
} satisfies MarketRadarCandidate;

describe("buildOpportunityBrief", () => {
  it("separates product evidence from category context and names missing money/competition data", () => {
    expect(
      buildOpportunityBrief({ offer, price, buyerVoice: voice, marketContext: [radar] }),
    ).toMatchObject({
      externalEvidenceIsUntrusted: true,
      offer: { id: "offer-1", title: "Organizador compacto", affiliateLinkAvailable: true },
      signals: {
        price: { status: "unknown", reason: "insufficient_history", evidence: [] },
        buyerVoice: { status: "observed", positiveReviews: 2, negativeReviews: 1, questions: 1 },
        marketContext: [
          {
            keyword: "organizador de geladeira",
            demandValidated: false,
            observedAt: "2026-10-01T12:00:00.000Z",
          },
        ],
        competition: { status: "missing" },
        salesAndProfit: { status: "not_measured" },
      },
      readiness: "incomplete",
      missingEvidence: [
        "product_specific_demand",
        "comparable_price_history",
        "competitor_observations",
        "confirmed_sales_and_profit",
      ],
    });
  });

  it("does not imply that a trend or affiliate link is a validated sale opportunity", () => {
    const brief = buildOpportunityBrief({ offer, price, marketContext: [radar] });
    expect(brief.signals.buyerVoice.status).toBe("missing");
    expect(brief.missingEvidence).toContain("buyer_voice_data");
    expect(brief.signals.salesAndProfit.status).toBe("not_measured");
    expect(brief.readiness).toBe("incomplete");
  });
});
