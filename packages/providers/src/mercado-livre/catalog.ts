import type {
  BuyerQuestion,
  BuyerReview,
  BuyerVoice,
  MarketplaceCatalog,
  ProductCandidate,
  ProductEvidence,
  ProductPicture,
  TrendKeyword,
} from "@money-maker/core/offers/marketplace-catalog";
import type { MercadoLivreClient, MercadoLivreResponse } from "./client.js";

type ApiProductSummary = Readonly<{ id?: string }>;
type ApiProduct = Readonly<{
  name?: string;
  permalink?: string;
  status?: string;
  domain_id?: string;
  attributes?: Readonly<{ id?: string; value_name?: string | null }>[];
  pictures?: Readonly<{
    url?: string;
    max_width?: number;
    max_height?: number;
  }>[];
  buy_box_winner?: ApiOffer | null;
}>;
const money = (priced: { price?: number; currency_id?: string }) => {
  if (typeof priced.price !== "number" || !priced.currency_id || !Number.isFinite(priced.price))
    throw new Error("malformed_money");
  return {
    amountMinor: Math.round(priced.price * 100),
    currency: priced.currency_id,
  };
};
type ApiOffer = Readonly<{
  item_id?: string;
  price?: number;
  original_price?: number | null;
  currency_id?: string;
  available_quantity?: number;
  sold_quantity?: number;
  shipping?: { free_shipping?: boolean };
  seller_id?: number;
  seller?: { nickname?: string };
}>;
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
/** Optional commercial facts; a field Mercado Livre omits (or a list price that is not above the price) stays absent. */
const commercialDetails = (
  offer: ApiOffer,
  currentPrice: { amountMinor: number; currency: string },
) => {
  const listMinor =
    typeof offer.original_price === "number" && Number.isFinite(offer.original_price)
      ? Math.round(offer.original_price * 100)
      : undefined;
  const soldQuantity = count(offer.sold_quantity);
  const availableQuantity = count(offer.available_quantity);
  const freeShipping = offer.shipping?.free_shipping;
  return {
    ...(listMinor !== undefined && listMinor > currentPrice.amountMinor
      ? {
          listPrice: {
            amountMinor: listMinor,
            currency: currentPrice.currency,
          },
        }
      : {}),
    ...(soldQuantity !== undefined ? { soldQuantity } : {}),
    ...(availableQuantity !== undefined ? { availableQuantity } : {}),
    ...(typeof freeShipping === "boolean" ? { freeShipping } : {}),
  };
};
/**
 * Maps a catalog product (GET /products/{id}) through one of its offers: the buy box winner, or
 * the first active offer from GET /products/{id}/items when Mercado Livre does not expose a winner.
 */
const brandOf = (product: ApiProduct): string | undefined =>
  product.attributes
    ?.find((attribute) => attribute.id === "BRAND")
    ?.value_name?.trim()
    .slice(0, 80) || undefined;
const productCandidate = (
  product: ApiProduct,
  productId: string,
  offer: ApiOffer | undefined,
): ProductCandidate => {
  if (!offer) throw new Error("no_active_offer");
  if (!offer.item_id || typeof offer.seller_id !== "number")
    throw new Error("missing_product_field");
  // Offers listed by /products/{id}/items are active and omit stock; the buy box reports it.
  if (offer.available_quantity === 0) throw new Error("listing_unavailable");
  if (!product.name) throw new Error("missing_product_field");
  const listingUrl = new URL(product.permalink || `https://www.mercadolivre.com.br/p/${productId}`);
  const currentPrice = money(offer);
  // The catalog product id is the stable identifier: third-party /items/{id} reads are denied.
  return {
    providerId: productId,
    title: product.name,
    listingUrl,
    seller: offer.seller?.nickname ?? `seller:${offer.seller_id}`,
    availability: "available",
    ...(product.domain_id ? { domainId: product.domain_id } : {}),
    ...(brandOf(product) ? { brand: brandOf(product) as string } : {}),
    listingStatus:
      product.status === "active" || product.status === "paused" || product.status === "closed"
        ? product.status
        : "unknown",
    currentPrice,
    ...commercialDetails(offer, currentPrice),
    ...(productPictures(product).length > 0 ? { pictures: productPictures(product) } : {}),
  };
};
/** Keeps Mercado Livre's status and error body (never tokens) so failures can be diagnosed from logs. */
export class MercadoLivreRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly providerError: string | undefined,
  ) {
    super(message);
    this.name = "MercadoLivreRequestError";
  }
}
const searchError = async (response: MercadoLivreResponse): Promise<MercadoLivreRequestError> => {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: unknown; message?: unknown; cause?: unknown }
    | undefined;
  const providerError = body ? JSON.stringify(body).slice(0, 500) : undefined;
  const message =
    response.status === 401 || response.status === 403
      ? "unauthorized"
      : response.status === 429
        ? "rate_limited"
        : response.status >= 500
          ? "provider_unavailable"
          : "provider_request_failed";
  return new MercadoLivreRequestError(message, response.status, providerError);
};
// Keyword search (/sites/MLB/search) is closed to third-party apps (403 even with a valid
// token); the catalog API below is the supported authenticated path.
const MAX_PRODUCT_DETAIL_CALLS = 20;
const MAX_REVIEWS_PER_SIDE = 5;
const MAX_BUYER_TEXT = 500;
const MAX_PICTURES = 10;
const dimension = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
/** Keeps only https photo URLs; import_asset_from_url fetches and verifies the bytes later. */
const productPictures = (product: ApiProduct): ProductPicture[] =>
  (product.pictures ?? [])
    .filter((picture) => typeof picture.url === "string" && picture.url.startsWith("https://"))
    .slice(0, MAX_PICTURES)
    .map((picture, position) => ({
      url: picture.url as string,
      width: dimension(picture.max_width),
      height: dimension(picture.max_height),
      position,
    }));
type ApiReview = Readonly<{ rate?: number; title?: string; content?: string }>;
type ApiReviews = Readonly<{
  reviews?: ApiReview[];
  rating_average?: number;
  paging?: { total?: number };
}>;
type ApiQuestions = Readonly<{
  questions?: Readonly<{ text?: string; answer?: { text?: string } | null }>[];
}>;
/** Buyer text is untrusted: collapse whitespace and bound its length before it leaves the adapter. */
const buyerText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_BUYER_TEXT) : "";
const reviewsWhere = (reviews: readonly ApiReview[], keep: (rate: number) => boolean) =>
  reviews
    .filter((review) => typeof review.rate === "number" && keep(review.rate))
    .map(
      (review): BuyerReview => ({
        rating: review.rate as number,
        title: buyerText(review.title),
        text: buyerText(review.content),
      }),
    )
    .filter((review) => review.text)
    .slice(0, MAX_REVIEWS_PER_SIDE);
export class MercadoLivreCatalog implements MarketplaceCatalog {
  public constructor(private readonly client: MercadoLivreClient) {}
  public async search(input: {
    query: string;
    limit: number;
  }): Promise<readonly ProductCandidate[]> {
    if (!input.query.trim() || input.limit < 1 || input.limit > 100)
      throw new Error("invalid_limit");
    const response = await this.client.request(
      `/products/search?status=active&site_id=MLB&q=${encodeURIComponent(input.query)}&limit=${input.limit}`,
    );
    if (response.status >= 400) throw await searchError(response);
    const body = (await response.json()) as { results?: ApiProductSummary[] };
    const cap = Math.min(input.limit, MAX_PRODUCT_DETAIL_CALLS);
    const items: ProductCandidate[] = [];
    for (const summary of (body.results ?? []).slice(0, cap)) {
      if (!summary.id) continue;
      try {
        items.push(await this.resolveProduct(summary.id));
      } catch (error) {
        // A provider refusal (403/429/5xx) stops the whole search; a product with no active
        // offer, no stock or missing fields is skipped.
        if (error instanceof MercadoLivreRequestError) throw error;
      }
    }
    return items;
  }
  /**
   * GET /sites/MLB/domain_discovery/search names the query's category; GET /highlights/MLB/
   * category/{id} lists its best sellers. Only catalog products (type PRODUCT) are kept, since
   * candidates are keyed by catalog product id.
   */
  public async searchBestSellers(input: {
    query: string;
    limit: number;
  }): Promise<readonly ProductCandidate[]> {
    if (!input.query.trim() || input.limit < 1 || input.limit > 100)
      throw new Error("invalid_limit");
    const discovery = await this.client.request(
      `/sites/MLB/domain_discovery/search?q=${encodeURIComponent(input.query)}&limit=1`,
    );
    if (discovery.status >= 400) throw await searchError(discovery);
    const [domain] = ((await discovery.json()) as Readonly<{ category_id?: string }>[]) ?? [];
    const categoryId = domain?.category_id;
    if (!categoryId || !/^MLB\d+$/.test(categoryId)) return [];
    const highlights = await this.client.request(`/highlights/MLB/category/${categoryId}`);
    if (highlights.status >= 400) throw await searchError(highlights);
    const body = (await highlights.json()) as {
      content?: Readonly<{ id?: string; position?: number; type?: string }>[];
    };
    const ranked = (body.content ?? [])
      .filter((entry) => entry.type === "PRODUCT" && entry.id && typeof entry.position === "number")
      .slice(0, Math.min(input.limit, MAX_PRODUCT_DETAIL_CALLS));
    const items: ProductCandidate[] = [];
    for (const entry of ranked) {
      try {
        items.push({
          ...(await this.resolveProduct(entry.id as string)),
          bestSellerRank: entry.position as number,
        });
      } catch (error) {
        if (error instanceof MercadoLivreRequestError) throw error;
      }
    }
    return items;
  }
  /** Resolves a catalog product and its active offer into a candidate. */
  private async resolveProduct(productId: string): Promise<ProductCandidate> {
    const { product, offer } = await this.productWithOffer(productId);
    return productCandidate(product, productId, offer);
  }
  private async productWithOffer(productId: string) {
    const detailResponse = await this.client.request(`/products/${encodeURIComponent(productId)}`);
    if (detailResponse.status >= 400) throw await searchError(detailResponse);
    const product = (await detailResponse.json()) as ApiProduct;
    const offer = product.buy_box_winner ?? (await this.firstActiveOffer(productId));
    return { product, offer };
  }
  /** Reads a buyer-facing endpoint; a 4xx refusal means "not available to this app", not failure. */
  private async optionalRead<T>(path: string): Promise<T | undefined> {
    const response = await this.client.request(path);
    if (response.status === 429 || response.status >= 500) throw await searchError(response);
    if (response.status >= 400) {
      // The refusal reason (e.g. PolicyAgent) is the only way to know what access is missing.
      const body = (await response.json().catch(() => undefined)) as
        | { code?: unknown; blocked_by?: unknown; error?: unknown; message?: unknown }
        | undefined;
      console.warn("mercado_livre_read_refused", {
        endpoint: path.split("?")[0]?.replace(/MLB\d+/g, "MLB…"),
        status: response.status,
        code: typeof body?.code === "string" ? body.code.slice(0, 80) : null,
        blockedBy: typeof body?.blocked_by === "string" ? body.blocked_by.slice(0, 40) : null,
        error: typeof body?.error === "string" ? body.error.slice(0, 80) : null,
        message: typeof body?.message === "string" ? body.message.slice(0, 160) : null,
      });
      return undefined;
    }
    return (await response.json()) as T;
  }
  private async firstActiveOffer(productId: string): Promise<ApiOffer | undefined> {
    const response = await this.client.request(
      `/products/${encodeURIComponent(productId)}/items?limit=1`,
    );
    // Mercado Livre answers 404 "No winners found" for a product without active offers.
    if (response.status === 404) return undefined;
    if (response.status >= 400) throw await searchError(response);
    const body = (await response.json()) as { results?: ApiOffer[] };
    return body.results?.[0];
  }
  /** GET /trends/MLB[/{categoryId}]: Mercado Livre's most searched terms, most searched first. */
  public async readTrends(categoryId?: string): Promise<readonly TrendKeyword[]> {
    if (categoryId !== undefined && !/^MLB\d+$/.test(categoryId))
      throw new Error("invalid_category");
    const response = await this.client.request(
      categoryId ? `/trends/MLB/${categoryId}` : "/trends/MLB",
    );
    if (response.status === 404) throw new Error("category_not_found");
    if (response.status >= 400) throw await searchError(response);
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return (body as Readonly<{ keyword?: unknown; url?: unknown }>[])
      .filter((entry) => typeof entry.keyword === "string" && entry.keyword.trim())
      .slice(0, 50)
      .map((entry) => ({
        keyword: buyerText(entry.keyword).slice(0, 100),
        url: typeof entry.url === "string" && entry.url.startsWith("https://") ? entry.url : null,
      }));
  }
  /**
   * Reviews of the buy-box item, first scoped to the catalog product, then (since 2026-10-15,
   * when the scoped read answered 403 for this app) the plain item read the docs describe.
   */
  private async readReviews(
    itemId: string,
    productId: string,
    limit: number,
  ): Promise<ApiReviews | undefined> {
    return (
      (await this.optionalRead<ApiReviews>(
        `/reviews/item/${itemId}?catalog_product_id=${encodeURIComponent(productId)}&limit=${limit}`,
      )) ?? (await this.optionalRead<ApiReviews>(`/reviews/item/${itemId}?limit=${limit}`))
    );
  }
  public async readBuyerVoice(productId: string): Promise<BuyerVoice> {
    const { product, offer } = await this.productWithOffer(productId);
    if (!offer?.item_id) throw new Error("no_active_offer");
    const itemId = encodeURIComponent(offer.item_id);
    const [reviews, questions] = await Promise.all([
      this.readReviews(itemId, productId, 50),
      this.optionalRead<ApiQuestions>(`/questions/search?item=${itemId}&limit=20`),
    ]);
    const reviewList = reviews?.reviews ?? [];
    return {
      providerId: productId,
      sourceUrl: new URL(product.permalink || `https://www.mercadolivre.com.br/p/${productId}`),
      observedAt: new Date(),
      ratingAverage: typeof reviews?.rating_average === "number" ? reviews.rating_average : null,
      reviewCount: typeof reviews?.paging?.total === "number" ? reviews.paging.total : null,
      positiveReviews: reviewsWhere(reviewList, (rate) => rate >= 4),
      negativeReviews: reviewsWhere(reviewList, (rate) => rate <= 2),
      questions: (questions?.questions ?? [])
        .map(
          (entry): BuyerQuestion => ({
            question: buyerText(entry.text),
            answer: buyerText(entry.answer?.text) || null,
          }),
        )
        .filter((entry) => entry.question),
      pictures: productPictures(product),
      unavailable: [
        ...(reviews ? [] : ["reviews" as const]),
        ...(questions ? [] : ["questions" as const]),
      ],
    };
  }
  public async readProductEvidence(productId: string): Promise<ProductEvidence> {
    const { product, offer } = await this.productWithOffer(productId);
    const candidate = productCandidate(product, productId, offer);
    const reviews = offer?.item_id
      ? await this.readReviews(encodeURIComponent(offer.item_id), productId, 1)
      : undefined;
    const reviewCount = count(reviews?.paging?.total);
    return {
      ...candidate,
      observedAt: new Date(),
      ...(typeof reviews?.rating_average === "number" && reviewCount
        ? { ratingAverage: reviews.rating_average, reviewCount }
        : {}),
    };
  }
}
