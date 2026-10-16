import type { Offer } from "../offers/offer.js";
import type { BuyerVoiceSummary } from "../offers/buyer-voice.js";
import type { OfferPriceIntelligence } from "../offers/price-intelligence.js";
import type { MarketRadarCandidate } from "./market-radar.js";

export type OpportunityBrief = Readonly<{
  externalEvidenceIsUntrusted: true;
  offer: Readonly<{
    id: string;
    marketplace: Offer["marketplace"];
    title: string;
    listingUrl: string;
    affiliateLinkAvailable: boolean;
  }>;
  signals: Readonly<{
    price: Readonly<{
      status: "real_deal" | "not_a_real_deal" | "unknown";
      reason: OfferPriceIntelligence["reason"];
      currentObservedPrice: OfferPriceIntelligence["currentObservedPrice"];
      average30d: OfferPriceIntelligence["average30d"];
      evidenceSamples: number;
      evidence: OfferPriceIntelligence["sampledPrices"];
    }>;
    buyerVoice: Readonly<{
      status: "observed" | "missing";
      unavailableReason: "not_supported" | "provider_unavailable" | null;
      positiveReviews: number;
      negativeReviews: number;
      questions: number;
      evidence: BuyerVoiceSummary["evidence"];
      sourceUrl: string | null;
      observedAt: string | null;
    }>;
    marketContext: readonly Readonly<{
      keyword: string;
      rank: number;
      sourceCount: number;
      observedAt: string;
      evidence: MarketRadarCandidate["evidence"];
      demandValidated: false;
    }>[];
    marketContextStatus: "available" | "not_requested" | "unavailable";
    competition: Readonly<{ status: "missing" }>;
    salesAndProfit: Readonly<{ status: "not_measured" }>;
  }>;
  readiness: "incomplete";
  missingEvidence: readonly string[];
}>;

export const buildOpportunityBrief = (input: {
  offer: Offer;
  price: OfferPriceIntelligence;
  buyerVoice?: BuyerVoiceSummary;
  buyerVoiceUnavailableReason?: "not_supported" | "provider_unavailable";
  marketContext?: readonly MarketRadarCandidate[];
  marketContextStatus?: "available" | "not_requested" | "unavailable";
}): OpportunityBrief => ({
  externalEvidenceIsUntrusted: true,
  offer: {
    id: input.offer.id,
    marketplace: input.offer.marketplace,
    title: input.offer.title,
    listingUrl: input.offer.listingUrl,
    affiliateLinkAvailable: Boolean(input.offer.affiliateUrl),
  },
  signals: {
    price: {
      status:
        input.price.isRealDeal === true
          ? "real_deal"
          : input.price.isRealDeal === false
            ? "not_a_real_deal"
            : "unknown",
      reason: input.price.reason,
      currentObservedPrice: input.price.currentObservedPrice,
      average30d: input.price.average30d,
      evidenceSamples: input.price.sampleCount30d,
      evidence: input.price.sampledPrices,
    },
    buyerVoice: {
      status: input.buyerVoice ? "observed" : "missing",
      unavailableReason: input.buyerVoice ? null : (input.buyerVoiceUnavailableReason ?? null),
      positiveReviews: input.buyerVoice?.positiveReviewCount ?? 0,
      negativeReviews: input.buyerVoice?.negativeReviewCount ?? 0,
      questions: input.buyerVoice?.questionCount ?? 0,
      evidence: input.buyerVoice?.evidence ?? [],
      sourceUrl: input.buyerVoice?.sourceUrl ?? null,
      observedAt: input.buyerVoice?.observedAt ?? null,
    },
    marketContext: (input.marketContext ?? []).map((candidate) => ({
      keyword: candidate.keyword,
      rank: candidate.rank,
      sourceCount: candidate.sourceCount,
      observedAt: candidate.observedAt.toISOString(),
      evidence: candidate.evidence,
      demandValidated: false,
    })),
    marketContextStatus: input.marketContextStatus ?? "not_requested",
    competition: { status: "missing" },
    salesAndProfit: { status: "not_measured" },
  },
  readiness: "incomplete",
  missingEvidence: [
    "product_specific_demand",
    ...(!input.buyerVoice ? ["buyer_voice_data"] : []),
    ...(input.price.isRealDeal === null ? ["comparable_price_history"] : []),
    "competitor_observations",
    "confirmed_sales_and_profit",
  ],
});
