import type { WorkspaceId } from "@money-maker/contracts";

export type Money = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type CommercialFactValue = string | number | boolean | Money;

export type CommercialFact = Readonly<{
  key: string;
  value: CommercialFactValue;
  sourceUrl: string;
  verified: boolean;
}>;

export type CommercialSnapshot = Readonly<{
  id: string;
  verifiedAt: Date;
  facts: readonly CommercialFact[];
}>;

export type OfferState = "draft" | "active" | "rejected" | "archived";

export type OfferMarketplace = "mercado_livre" | "tiktok_shop";

export type Offer = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  marketplace: OfferMarketplace;
  listingUrl: string;
  affiliateUrl?: string;
  /** TikTok Shop's provider product id. Never set for a mercado_livre offer. */
  externalProductId?: string;
  title: string;
  listPrice?: Money;
  currentPrice?: Money;
  discount?: Money;
  shipping?: Money;
  commission?: Money;
  fees?: Money;
  revenue?: Money;
  state: OfferState;
  snapshots: readonly CommercialSnapshot[];
  activeSnapshotId?: string;
  rejectionReason?: string;
}>;

export type CreateOfferInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  marketplace: OfferMarketplace;
  listingUrl: string;
  affiliateUrl?: string;
  externalProductId?: string;
  title: string;
  listPrice?: Money;
  currentPrice?: Money;
  discount?: Money;
  shipping?: Money;
  commission?: Money;
  fees?: Money;
  revenue?: Money;
}>;

const affiliateHosts = /(^|\.)(meli\.la|mercadolivre\.com\.br|mercadolibre\.com)$/;

/** Only HTTPS links on Mercado Livre domains are valid affiliate URLs. */
export const isMercadoLivreAffiliateUrl = (url: URL): boolean =>
  url.protocol === "https:" && affiliateHosts.test(url.hostname);

const tiktokShopListingHosts = /(^|\.)tiktok\.com$/;
const externalProductIdPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** Only HTTPS TikTok product pages are valid TikTok Shop listing URLs. */
export const isTikTokShopListingUrl = (url: URL): boolean =>
  url.protocol === "https:" && tiktokShopListingHosts.test(url.hostname);

const evidenceRequiredKeysByMarketplace: Readonly<Record<OfferMarketplace, readonly string[]>> = {
  mercado_livre: ["seller", "availability", "current_price"],
  // Operator-observed on the official product page; no availability key (§7 of the design).
  tiktok_shop: ["seller", "current_price", "commission_percent"],
};
const evidenceMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
/** How old an active TikTok Shop snapshot may be at approval / manual publication confirmation. */
export const TIKTOK_SHOP_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const assertUrl = (value: string, label: string): void => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${label} must be a valid HTTP URL`);
  }
};

const freezeMoney = (money: Money): Money => {
  if (!Number.isInteger(money.amountMinor)) throw new Error("Money amount must be an integer");
  if (money.amountMinor < 0) throw new Error("Money amount cannot be negative");
  if (!/^[A-Z]{3}$/.test(money.currency)) {
    throw new Error("Money currency must be an ISO 4217 code");
  }
  return Object.freeze({ amountMinor: money.amountMinor, currency: money.currency });
};

const freezeFact = (fact: CommercialFact): CommercialFact => {
  if (fact.key.trim().length === 0) throw new Error("Commercial fact key is required");
  assertUrl(fact.sourceUrl, "Commercial fact source URL");
  const value = typeof fact.value === "object" ? freezeMoney(fact.value) : fact.value;
  return Object.freeze({ ...fact, key: fact.key.trim(), value });
};

const freezeSnapshot = (snapshot: CommercialSnapshot): CommercialSnapshot => {
  if (snapshot.id.trim().length === 0) throw new Error("Commercial snapshot ID is required");
  if (Number.isNaN(snapshot.verifiedAt.getTime())) {
    throw new Error("Commercial snapshot verification time is invalid");
  }
  const facts = Object.freeze(snapshot.facts.map(freezeFact));
  if (new Set(facts.map((fact) => fact.key)).size !== facts.length) {
    throw new Error("Commercial snapshot facts must be unique");
  }
  return Object.freeze({ ...snapshot, facts });
};

const sameValue = (left: CommercialFactValue, right: CommercialFactValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createOffer = (input: CreateOfferInput): Offer => {
  assertUrl(input.listingUrl, "Listing URL");
  if (input.affiliateUrl) assertUrl(input.affiliateUrl, "Affiliate URL");
  if (input.title.trim().length === 0) throw new Error("Offer title is required");

  if (input.marketplace === "tiktok_shop") {
    if (!input.externalProductId || !externalProductIdPattern.test(input.externalProductId)) {
      throw new Error("TikTok Shop external product id is required");
    }
    if (input.affiliateUrl) {
      throw new Error("TikTok Shop offers have no affiliate URL; the product is attached in-app");
    }
    if (!isTikTokShopListingUrl(new URL(input.listingUrl))) {
      throw new Error("TikTok Shop listing URL must be an HTTPS tiktok.com product page");
    }
  } else if (input.externalProductId) {
    throw new Error("externalProductId is only valid for tiktok_shop offers");
  }

  const moneyFields = [
    input.listPrice,
    input.currentPrice,
    input.discount,
    input.shipping,
    input.commission,
    input.fees,
    input.revenue,
  ];
  for (const money of moneyFields) if (money) freezeMoney(money);

  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    marketplace: input.marketplace,
    listingUrl: input.listingUrl,
    ...(input.affiliateUrl ? { affiliateUrl: input.affiliateUrl } : {}),
    ...(input.externalProductId ? { externalProductId: input.externalProductId } : {}),
    title: input.title.trim(),
    ...(input.listPrice ? { listPrice: freezeMoney(input.listPrice) } : {}),
    ...(input.currentPrice ? { currentPrice: freezeMoney(input.currentPrice) } : {}),
    ...(input.discount ? { discount: freezeMoney(input.discount) } : {}),
    ...(input.shipping ? { shipping: freezeMoney(input.shipping) } : {}),
    ...(input.commission ? { commission: freezeMoney(input.commission) } : {}),
    ...(input.fees ? { fees: freezeMoney(input.fees) } : {}),
    ...(input.revenue ? { revenue: freezeMoney(input.revenue) } : {}),
    state: "draft" as const,
    snapshots: Object.freeze([]) as readonly CommercialSnapshot[],
  });
};

export const addEvidenceSnapshot = (offer: Offer, snapshot: CommercialSnapshot): Offer => {
  if (offer.state === "archived") throw new Error("Archived offers cannot receive evidence");
  if (offer.snapshots.some((existing) => existing.id === snapshot.id)) {
    throw new Error("Commercial snapshot ID already exists");
  }
  const normalized = freezeSnapshot(snapshot);
  const knownFacts = new Map<string, CommercialFactValue>();
  for (const existing of offer.snapshots) {
    for (const fact of existing.facts) knownFacts.set(fact.key, fact.value);
  }
  for (const fact of normalized.facts) {
    const previous = knownFacts.get(fact.key);
    if (previous !== undefined && !sameValue(previous, fact.value)) {
      throw new Error("Commercial evidence conflicts");
    }
  }
  return Object.freeze({
    ...offer,
    snapshots: Object.freeze([...offer.snapshots, normalized]),
  });
};

/** Facts a fresh read of the same marketplace listing may legitimately change on its own. */
const refreshVolatileFactKeys = new Set([
  "current_price",
  "list_price",
  "discount_percent",
  "availability",
  "available_quantity",
  "listing_status",
  "free_shipping",
  // Lifetime counters and ratings move with every sale or review.
  "sold_quantity",
  "rating_average",
  "review_count",
  // TikTok Shop volatile facts: commission plans, stock and sample offers change per campaign.
  "commission_percent",
  "stock_status",
  "sample_available",
]);

/**
 * A system refresh of an already-active offer: like `addEvidenceSnapshot`, but a volatile fact
 * (price, list price, discount, availability/stock, shipping) may differ from earlier evidence
 * without being treated as a conflict. Any other fact (for example `seller`) still must match, so
 * an identity change is still a conflict and the caller should skip the offer.
 */
export const addRefreshedSnapshot = (offer: Offer, snapshot: CommercialSnapshot): Offer => {
  if (offer.state === "archived") throw new Error("Archived offers cannot receive evidence");
  if (offer.snapshots.some((existing) => existing.id === snapshot.id)) {
    throw new Error("Commercial snapshot ID already exists");
  }
  const normalized = freezeSnapshot(snapshot);
  const knownFacts = new Map<string, CommercialFactValue>();
  for (const existing of offer.snapshots) {
    for (const fact of existing.facts) knownFacts.set(fact.key, fact.value);
  }
  for (const fact of normalized.facts) {
    if (refreshVolatileFactKeys.has(fact.key)) continue;
    const previous = knownFacts.get(fact.key);
    if (previous !== undefined && !sameValue(previous, fact.value)) {
      throw new Error("Commercial evidence conflicts");
    }
  }
  return Object.freeze({
    ...offer,
    snapshots: Object.freeze([...offer.snapshots, normalized]),
  });
};

/** The Mercado Livre catalog product id embedded in the listing URL, or in an older snapshot id. */
export const productIdFromOffer = (offer: Pick<Offer, "listingUrl" | "snapshots">): string | null =>
  offer.listingUrl.match(/\/p\/(MLB\d+)/)?.[1] ??
  offer.snapshots.map((entry) => entry.id.match(/^ml-(MLB\d+)-/)?.[1]).find(Boolean) ??
  null;

const latestSnapshot = (offer: Offer): CommercialSnapshot | undefined =>
  [...offer.snapshots].sort(
    (left, right) => right.verifiedAt.getTime() - left.verifiedAt.getTime(),
  )[0];

export const activateOffer = (offer: Offer, now = new Date()): Offer => {
  if (offer.state === "archived") throw new Error("Archived offers cannot be activated");
  if (offer.marketplace === "mercado_livre" && !offer.affiliateUrl) {
    throw new Error("Affiliate URL is required");
  }
  const snapshot = latestSnapshot(offer);
  if (!snapshot) throw new Error("Verified commercial evidence is required");
  if (now.getTime() - snapshot.verifiedAt.getTime() > evidenceMaxAgeMs) {
    throw new Error("Commercial evidence is stale");
  }
  if (snapshot.facts.some((fact) => !fact.verified)) {
    throw new Error("Commercial evidence is unverified");
  }
  const factKeys = new Set(snapshot.facts.map((fact) => fact.key));
  const requiredKeys = evidenceRequiredKeysByMarketplace[offer.marketplace];
  if (requiredKeys.some((key) => !factKeys.has(key))) {
    throw new Error("Required commercial evidence is missing");
  }
  return Object.freeze({
    ...offer,
    state: "active" as const,
    activeSnapshotId: snapshot.id,
  });
};

/**
 * Where the buyer goes: Mercado Livre's official affiliate URL, or TikTok Shop's in-app product
 * attachment token (no external URL exists). Null when the offer has neither yet. Used everywhere
 * a publication fingerprint or a manual-publication kit needs "the destination" without caring
 * which marketplace produced it (invariant C1, design §7).
 */
export const offerDestination = (
  offer: Pick<Offer, "marketplace" | "affiliateUrl" | "externalProductId">,
): string | null => {
  if (offer.marketplace === "tiktok_shop") {
    return offer.externalProductId ? `tiktokshop:product/${offer.externalProductId}` : null;
  }
  return offer.affiliateUrl ?? null;
};

export const rejectOffer = (offer: Offer, reason: string): Offer => {
  if (reason.trim().length === 0) throw new Error("Offer rejection reason is required");
  if (offer.state === "archived") throw new Error("Archived offers cannot be rejected");
  return Object.freeze({
    ...offer,
    state: "rejected" as const,
    rejectionReason: reason.trim(),
  });
};
