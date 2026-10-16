import type { Money } from "../offers/offer.js";
import type { NicheStorefrontCandidate } from "./attribution-repository.js";

/** A price the storefront may show: read from Mercado Livre at `verifiedAt`. */
export type StorefrontPrice = Readonly<{ current: Money; list?: Money; verifiedAt: Date }>;

export type StorefrontCard = Readonly<{
  offerId: string;
  offerTitle: string;
  affiliateUrl: string;
  contentVariantId: string;
  assetId: string;
  publishedAt: Date;
  price?: StorefrontPrice;
}>;

/** An older price may no longer match the listing, so the card shows none. */
export const STOREFRONT_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Both prices come from the same snapshot; the list price only when it is really higher. */
const freshPrice = (
  snapshot: NicheStorefrontCandidate["activeSnapshot"],
  now: Date,
): StorefrontPrice | undefined => {
  if (!snapshot?.currentPrice) return undefined;
  if (now.getTime() - snapshot.verifiedAt.getTime() > STOREFRONT_PRICE_MAX_AGE_MS) return undefined;
  const { currentPrice: current, listPrice: list } = snapshot;
  const showList =
    list && list.currency === current.currency && list.amountMinor > current.amountMinor;
  return { current, ...(showList ? { list } : {}), verifiedAt: snapshot.verifiedAt };
};

/** The bio storefront shows at most this many offers; older ones drop off. */
export const STOREFRONT_CARD_LIMIT = 30;

/**
 * One card per offer, newest first: the offer's instagram_carousel variant with an image when
 * one exists, else its newest pictured variant of any kind. An offer with no pictured variant
 * never shows up, since there is nothing to render.
 */
export const buildNicheStorefront = (
  candidates: readonly NicheStorefrontCandidate[],
  now: Date = new Date(),
): readonly StorefrontCard[] => {
  const picked = new Map<string, NicheStorefrontCandidate>();
  for (const candidate of candidates) {
    if (!candidate.assetId) continue;
    // A refresh found the listing delisted or out of stock: hide the whole card, not just its price.
    if (candidate.activeSnapshot?.available === false) continue;
    const current = picked.get(candidate.offerId);
    if (!current) {
      picked.set(candidate.offerId, candidate);
      continue;
    }
    const currentPreferred = current.channelKind === "instagram_carousel";
    const candidatePreferred = candidate.channelKind === "instagram_carousel";
    if (candidatePreferred && !currentPreferred) {
      picked.set(candidate.offerId, candidate);
    } else if (
      candidatePreferred === currentPreferred &&
      candidate.publishedAt > current.publishedAt
    ) {
      picked.set(candidate.offerId, candidate);
    }
  }
  return [...picked.values()]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, STOREFRONT_CARD_LIMIT)
    .map((candidate) => {
      const price = freshPrice(candidate.activeSnapshot, now);
      return {
        offerId: candidate.offerId,
        offerTitle: candidate.offerTitle,
        affiliateUrl: candidate.affiliateUrl,
        contentVariantId: candidate.contentVariantId,
        assetId: candidate.assetId as string,
        publishedAt: candidate.publishedAt,
        ...(price ? { price } : {}),
      };
    });
};
