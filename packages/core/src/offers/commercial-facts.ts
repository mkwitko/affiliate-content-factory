import type { ProductEvidence } from "./marketplace-catalog.js";
import type { CommercialFact, CommercialFactValue, Money } from "./offer.js";

/**
 * One fact per field Mercado Livre returned; an absent field never becomes a fact. Shared by the
 * manual import tool and the system refresh loop so both write evidence the same way.
 */
export const commercialFactsFromEvidence = (evidence: ProductEvidence): CommercialFact[] => {
  const values: [string, CommercialFactValue | undefined][] = [
    ["seller", evidence.seller],
    ["availability", evidence.availability],
    ["listing_status", evidence.listingStatus],
    ["current_price", evidence.currentPrice],
    ["list_price", evidence.listPrice],
    // Derived from the two prices above; rounded down so the caption never overstates the discount.
    [
      "discount_percent",
      evidence.listPrice
        ? Math.floor((1 - evidence.currentPrice.amountMinor / evidence.listPrice.amountMinor) * 100)
        : undefined,
    ],
    ["sold_quantity", evidence.soldQuantity],
    ["available_quantity", evidence.availableQuantity],
    ["free_shipping", evidence.freeShipping],
    ["rating_average", evidence.ratingAverage],
    ["review_count", evidence.reviewCount],
  ];
  return values.flatMap(([key, value]) =>
    value === undefined
      ? []
      : [{ key, value, sourceUrl: evidence.listingUrl.toString(), verified: true }],
  );
};

/** An operator-observed TikTok Shop product page; no scraping, no automatic re-verification. */
export type TikTokShopProductObservation = Readonly<{
  productId: string;
  seller: string;
  currentPrice: Money;
  listPrice?: Money;
  commissionPercent: number;
  commissionPlan?: string;
  sampleAvailable?: boolean;
  category?: string;
  stockStatus?: string;
  productUrl: string;
}>;

/**
 * One fact per operator-observed TikTok Shop field. Always `verified: true`: the operator read it
 * directly off the official product page, the same trust level as a screenshot reference (design
 * §12). Shared by import_tiktok_shop_product (planned) so evidence is written the same way.
 */
export const commercialFactsFromTikTokShopObservation = (
  observation: TikTokShopProductObservation,
): CommercialFact[] => {
  const values: [string, CommercialFactValue | undefined][] = [
    ["product_id", observation.productId],
    ["seller", observation.seller],
    ["current_price", observation.currentPrice],
    ["list_price", observation.listPrice],
    [
      "discount_percent",
      observation.listPrice
        ? Math.floor(
            (1 - observation.currentPrice.amountMinor / observation.listPrice.amountMinor) * 100,
          )
        : undefined,
    ],
    ["commission_percent", observation.commissionPercent],
    ["commission_plan", observation.commissionPlan],
    ["sample_available", observation.sampleAvailable],
    ["category", observation.category],
    ["stock_status", observation.stockStatus],
  ];
  return values.flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value, sourceUrl: observation.productUrl, verified: true }],
  );
};
