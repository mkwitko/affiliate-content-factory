import type { Money } from "./offer.js";
export type ProductCandidate = Readonly<{
  providerId: string;
  title: string;
  listingUrl: URL;
  seller: string;
  availability: string;
  /** Marketplace product family, e.g. Mercado Livre's `MLB-BOOKS`. */
  domainId?: string;
  /** The product's brand as the marketplace states it. */
  brand?: string;
  /** 1-based position in the marketplace's best-seller list for the product's category. */
  bestSellerRank?: number;
  listingStatus: "active" | "paused" | "closed" | "unknown";
  currentPrice: Money;
  /** Present only when Mercado Livre reports a list price above the current price. */
  listPrice?: Money;
  /** Mercado Livre calls these counts "referential": approximate, never exact. */
  soldQuantity?: number;
  availableQuantity?: number;
  freeShipping?: boolean;
  pictures?: readonly ProductPicture[];
}>;
export type ProductEvidence = Readonly<
  ProductCandidate & {
    observedAt: Date;
    ratingAverage?: number;
    reviewCount?: number;
  }
>;
export type BuyerReview = Readonly<{
  rating: number;
  title: string;
  text: string;
}>;
export type BuyerQuestion = Readonly<{
  question: string;
  answer: string | null;
}>;
/** Official listing photo; the real product base for creatives. */
export type ProductPicture = Readonly<{
  url: string;
  width: number | null;
  height: number | null;
  position: number;
}>;
/** Untrusted buyer text (reviews, questions) read from the marketplace for copy research. */
export type BuyerVoice = Readonly<{
  providerId: string;
  sourceUrl: URL;
  observedAt: Date;
  ratingAverage: number | null;
  reviewCount: number | null;
  positiveReviews: readonly BuyerReview[];
  negativeReviews: readonly BuyerReview[];
  questions: readonly BuyerQuestion[];
  pictures: readonly ProductPicture[];
  unavailable: readonly ("reviews" | "questions")[];
}>;
/** A search term that is trending on the marketplace, most searched first. */
export type TrendKeyword = Readonly<{ keyword: string; url: string | null }>;
export interface MarketplaceCatalog {
  search(input: { query: string; limit: number }): Promise<readonly ProductCandidate[]>;
  readProductEvidence(productId: string): Promise<ProductEvidence>;
  readBuyerVoice(productId: string): Promise<BuyerVoice>;
  /**
   * The marketplace's best sellers in the category a query points to, best first, each with
   * `bestSellerRank`. Empty when the marketplace does not serve the list to this app.
   */
  searchBestSellers?(input: { query: string; limit: number }): Promise<readonly ProductCandidate[]>;
  /** Trending searches, site-wide or within one marketplace category. */
  readTrends?(categoryId?: string): Promise<readonly TrendKeyword[]>;
}
