import type { BuyerVoice, ProductEvidence } from "../offers/marketplace-catalog.js";
import type { CandidateQualification } from "./product-candidate.js";

export const MIN_REVIEW_COUNT = 5;
/**
 * Mercado Livre's reviews endpoint has refused this app since 2026-09-26. A product it reports as
 * this well sold still qualifies, with the missing rating stated in the reasons.
 */
export const MIN_SOLD_WITHOUT_REVIEWS = 100;
/** Or a product this high in its category's best-seller list. */
export const MAX_BEST_SELLER_RANK = 20;
const EXCERPT_MAX = 160;

export type DuplicateContext = Readonly<{
  openProductIds: ReadonlySet<string>;
  offerProductIds: ReadonlySet<string>;
  cooldownProductIds: ReadonlySet<string>;
}>;

type DuplicateReason = "already_pending" | "already_offer" | "recently_posted";

export type QualificationOutcome =
  | Readonly<{ kind: "qualified"; qualification: CandidateQualification }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "listing_inactive"
        | "out_of_stock"
        | "no_rating"
        | "too_few_reviews"
        | "evidence_unavailable";
    }>
  | Readonly<{ kind: "duplicate"; reason: DuplicateReason }>;

export const duplicateReason = (
  providerId: string,
  ctx: DuplicateContext,
): DuplicateReason | null => {
  if (ctx.openProductIds.has(providerId)) return "already_pending";
  if (ctx.offerProductIds.has(providerId)) return "already_offer";
  if (ctx.cooldownProductIds.has(providerId)) return "recently_posted";
  return null;
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const excerpt = (value: string | undefined): string | null => {
  const text = value?.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, EXCERPT_MAX) : null;
};

/** Pure screening of one product's evidence. Buyer text is untrusted and only truncated, never interpreted. */
export const qualifyCandidate = (input: {
  evidence: ProductEvidence;
  voice: BuyerVoice | null;
  prioritize: readonly string[];
  /** Best-seller position seen at discovery, when there was one. */
  bestSellerRank?: number | undefined;
  now: Date;
}): QualificationOutcome => {
  const { evidence, voice } = input;
  if (evidence.listingStatus !== "active") return { kind: "rejected", reason: "listing_inactive" };
  if (evidence.availableQuantity !== undefined && evidence.availableQuantity <= 0)
    return { kind: "rejected", reason: "out_of_stock" };
  const rating = evidence.ratingAverage;
  const reviewCount = evidence.reviewCount;
  const unrated = rating === undefined && reviewCount === undefined;
  const bestSeller =
    input.bestSellerRank !== undefined && input.bestSellerRank <= MAX_BEST_SELLER_RANK
      ? input.bestSellerRank
      : undefined;
  if (
    unrated &&
    (evidence.soldQuantity ?? 0) < MIN_SOLD_WITHOUT_REVIEWS &&
    bestSeller === undefined
  )
    return { kind: "rejected", reason: "evidence_unavailable" };
  if (!unrated && (rating === undefined || !reviewCount))
    return { kind: "rejected", reason: "no_rating" };
  if (reviewCount !== undefined && reviewCount < MIN_REVIEW_COUNT)
    return { kind: "rejected", reason: "too_few_reviews" };

  const title = evidence.title.toLowerCase();
  const matches = input.prioritize.filter((term) => title.includes(term.toLowerCase())).length;
  const sold = evidence.soldQuantity ?? 0;
  const parts = {
    reviews: round1(Math.log10((reviewCount ?? 0) + 1) * 20),
    rating: round1((rating ?? 0) * 10),
    sold: round1(Math.log10(sold + 1) * 10),
    prioritize: 5 * matches,
    bestSeller: bestSeller === undefined ? 0 : MAX_BEST_SELLER_RANK + 1 - bestSeller,
  };
  const score = round1(
    parts.reviews + parts.rating + parts.sold + parts.prioritize + parts.bestSeller,
  );

  const complaint = excerpt(voice?.negativeReviews[0]?.text);
  const reasons = [
    unrated
      ? "rating unavailable from Mercado Livre"
      : `rating ${rating} from ${reviewCount} reviews`,
  ];
  if (evidence.soldQuantity !== undefined) reasons.push(`about ${sold} sold`);
  if (bestSeller !== undefined) reasons.push(`best seller #${bestSeller} in its category`);
  if (evidence.freeShipping) reasons.push("free shipping");
  if (matches > 0) reasons.push(`${matches} prioritized term(s) in title`);

  return {
    kind: "qualified",
    qualification: Object.freeze({
      version: 1 as const,
      facts: {
        rating: rating ?? null,
        reviewCount: reviewCount ?? null,
        soldQuantity: evidence.soldQuantity ?? null,
        listPriceMinor: evidence.listPrice?.amountMinor ?? null,
        freeShipping: evidence.freeShipping ?? null,
        observedAt: evidence.observedAt.toISOString(),
        brand: evidence.brand ?? null,
        domainId: evidence.domainId ?? null,
      },
      heuristic: { score, parts },
      hypotheses: [complaint ? "angle: buyer complaint addressed" : "angle: demonstration"],
      buyerVoice: voice
        ? {
            topPraise: excerpt(voice.positiveReviews[0]?.text),
            topComplaint: complaint,
            firstQuestion: excerpt(voice.questions[0]?.question),
            untrusted: true as const,
          }
        : null,
      reasons,
    }),
  };
};
