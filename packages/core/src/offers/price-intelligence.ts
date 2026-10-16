import {
  TIKTOK_SHOP_SNAPSHOT_MAX_AGE_MS,
  type CommercialFact,
  type CommercialFactValue,
  type Money,
  type Offer,
} from "./offer.js";
import { PUBLISH_MAX_SNAPSHOT_AGE_MS } from "./publish-freshness.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_30D_MS = 30 * DAY_MS;
const HISTORY_90D_MS = 90 * DAY_MS;
const MIN_HISTORY_SPAN_MS = 7 * DAY_MS;
const MIN_HISTORY_SAMPLES = 5;

type Reason =
  | "latest_snapshot_stale"
  | "latest_listing_unavailable"
  | "current_price_unverified"
  | "availability_unverified"
  | "seller_unverified"
  | "seller_changed"
  | "variation_changed"
  | "currency_changed"
  | "insufficient_history"
  | "below_historical_average"
  | "not_below_historical_average";

type PricePoint = Readonly<{
  verifiedAt: Date;
  price: Money;
  seller?: string;
  variationId?: string;
  available: boolean | null;
  sourceUrl: string;
}>;

const fact = (facts: readonly CommercialFact[], key: string) =>
  facts.find((candidate) => candidate.key === key && candidate.verified)?.value;

const moneyValue = (value: CommercialFactValue | undefined): Money | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger(value.amountMinor) ||
    value.amountMinor <= 0 ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    return null;
  return value;
};

const availability = (value: CommercialFactValue | undefined): boolean | null => {
  if (value === true || value === "available" || value === "in_stock") return true;
  if (value === false || value === "unavailable" || value === "out_of_stock") return false;
  return null;
};

const availabilityFor = (
  snapshot: Offer["snapshots"][number],
  marketplace: Offer["marketplace"],
): boolean | null => {
  if (marketplace === "tiktok_shop") {
    const stock = fact(snapshot.facts, "stock_status");
    if (stock === "in_stock" || stock === "low_stock") return true;
    if (stock === "out_of_stock") return false;
    return null;
  }
  const status = fact(snapshot.facts, "listing_status");
  if (status === "paused" || status === "closed") return false;
  return availability(fact(snapshot.facts, "availability"));
};

const pointFor = (
  snapshot: Offer["snapshots"][number],
  marketplace: Offer["marketplace"],
): PricePoint | null => {
  const priceFact = snapshot.facts.find((candidate) => candidate.key === "current_price");
  const price = priceFact?.verified ? moneyValue(priceFact.value) : null;
  if (!price || !priceFact) return null;
  const seller = fact(snapshot.facts, "seller");
  const variationId = fact(snapshot.facts, "variation_id");
  return {
    verifiedAt: snapshot.verifiedAt,
    price,
    ...(typeof seller === "string" ? { seller } : {}),
    ...(typeof variationId === "string" ? { variationId } : {}),
    available: availabilityFor(snapshot, marketplace),
    sourceUrl: priceFact.sourceUrl,
  };
};

const average = (prices: readonly Money[], currency: string): Money | null =>
  prices.length
    ? {
        amountMinor: Math.round(
          prices.reduce((sum, price) => sum + price.amountMinor, 0) / prices.length,
        ),
        currency,
      }
    : null;

const percentBps = (reference: number, current: number) =>
  reference > 0 ? Math.round(((reference - current) / reference) * 10_000) : null;

export type OfferPriceIntelligence = Readonly<{
  offerId: string;
  marketplace: Offer["marketplace"];
  currentObservedPrice: Money | null;
  advertisedListPrice: Money | null;
  advertisedDiscountBps: number | null;
  observedMin90d: Money | null;
  observedMax90d: Money | null;
  observedMin90dSample: Readonly<{ verifiedAt: Date; sourceUrl: string }> | null;
  observedMax90dSample: Readonly<{ verifiedAt: Date; sourceUrl: string }> | null;
  average30d: Money | null;
  sampleCount30d: number;
  sampleCount90d: number;
  observedFrom: Date | null;
  observedTo: Date | null;
  sampledPrices: readonly Readonly<{ verifiedAt: Date; price: Money; sourceUrl: string }>[];
  sampledPricesTruncated: number;
  discountVsAverageBps: number | null;
  discountVsHistoricalHighBps: number | null;
  isRealDeal: boolean | null;
  reason: Reason;
  comparableRule: string;
}>;

export const analyzeOfferPriceHistory = (
  input: Readonly<{
    offer: Offer;
    now: Date;
  }>,
): OfferPriceIntelligence => {
  const ordered = [...input.offer.snapshots]
    .filter(
      (snapshot) =>
        Number.isFinite(snapshot.verifiedAt.getTime()) && snapshot.verifiedAt <= input.now,
    )
    .sort((left, right) => left.verifiedAt.getTime() - right.verifiedAt.getTime());
  const latestSnapshot = ordered.at(-1);
  const latestPoint = latestSnapshot ? pointFor(latestSnapshot, input.offer.marketplace) : null;
  const currentObservedPrice = latestPoint?.price ?? null;
  const advertisedListPrice = latestSnapshot
    ? moneyValue(fact(latestSnapshot.facts, "list_price"))
    : null;
  const points90d = ordered
    .filter((snapshot) => snapshot.verifiedAt.getTime() >= input.now.getTime() - HISTORY_90D_MS)
    .map((snapshot) => pointFor(snapshot, input.offer.marketplace))
    .filter((point): point is PricePoint => point !== null);

  const sellerChanged =
    latestPoint?.seller !== undefined &&
    points90d.some((point) => point.seller !== undefined && point.seller !== latestPoint.seller);
  const variationChanged =
    latestPoint !== null &&
    points90d.some((point) => point.variationId !== latestPoint.variationId);
  const currencyChanged =
    latestPoint !== null &&
    points90d.some((point) => point.price.currency !== latestPoint.price.currency);
  const comparable = latestPoint?.seller
    ? points90d.filter(
        (point) =>
          point.available === true &&
          point.seller === latestPoint.seller &&
          point.variationId === latestPoint.variationId &&
          point.price.currency === latestPoint.price.currency,
      )
    : [];
  const since30d = input.now.getTime() - HISTORY_30D_MS;
  const points30d = comparable.filter((point) => point.verifiedAt.getTime() >= since30d);
  const prices30d = points30d.map((point) => point.price);
  const min90dPoint = comparable.reduce<PricePoint | null>(
    (selected, point) =>
      !selected || point.price.amountMinor < selected.price.amountMinor ? point : selected,
    null,
  );
  const max90dPoint = comparable.reduce<PricePoint | null>(
    (selected, point) =>
      !selected || point.price.amountMinor > selected.price.amountMinor ? point : selected,
    null,
  );
  const observedMin90d = min90dPoint?.price ?? null;
  const observedMax90d = max90dPoint?.price ?? null;
  const average30d = average(prices30d, latestPoint?.price.currency ?? "BRL");
  const observedFrom = points30d[0]?.verifiedAt ?? null;
  const observedTo = points30d.at(-1)?.verifiedAt ?? null;
  const sampledPrices = points30d.slice(-120).map(({ verifiedAt, price, sourceUrl }) => ({
    verifiedAt,
    price,
    sourceUrl,
  }));
  const adequateHistory =
    points30d.length >= MIN_HISTORY_SAMPLES &&
    observedFrom !== null &&
    observedTo !== null &&
    observedTo.getTime() - observedFrom.getTime() >= MIN_HISTORY_SPAN_MS;

  let reason: Reason = "insufficient_history";
  const freshnessWindowMs =
    input.offer.marketplace === "tiktok_shop"
      ? TIKTOK_SHOP_SNAPSHOT_MAX_AGE_MS
      : PUBLISH_MAX_SNAPSHOT_AGE_MS;
  if (
    latestSnapshot &&
    input.now.getTime() - latestSnapshot.verifiedAt.getTime() > freshnessWindowMs
  )
    reason = "latest_snapshot_stale";
  else if (latestSnapshot && availabilityFor(latestSnapshot, input.offer.marketplace) === false)
    reason = "latest_listing_unavailable";
  else if (!latestPoint) reason = "current_price_unverified";
  else if (latestPoint.available !== true) reason = "availability_unverified";
  else if (!latestPoint.seller) reason = "seller_unverified";
  else if (sellerChanged) reason = "seller_changed";
  else if (variationChanged) reason = "variation_changed";
  else if (currencyChanged) reason = "currency_changed";
  else if (adequateHistory && average30d)
    reason =
      latestPoint.price.amountMinor < average30d.amountMinor
        ? "below_historical_average"
        : "not_below_historical_average";

  const decisionAllowed =
    reason === "below_historical_average" || reason === "not_below_historical_average";
  const listPriceComparable =
    advertisedListPrice && currentObservedPrice?.currency === advertisedListPrice.currency
      ? advertisedListPrice
      : null;
  return {
    offerId: input.offer.id,
    marketplace: input.offer.marketplace,
    currentObservedPrice,
    advertisedListPrice,
    advertisedDiscountBps:
      listPriceComparable &&
      currentObservedPrice &&
      listPriceComparable.amountMinor > currentObservedPrice.amountMinor
        ? percentBps(listPriceComparable.amountMinor, currentObservedPrice.amountMinor)
        : null,
    observedMin90d,
    observedMax90d,
    observedMin90dSample: min90dPoint
      ? { verifiedAt: min90dPoint.verifiedAt, sourceUrl: min90dPoint.sourceUrl }
      : null,
    observedMax90dSample: max90dPoint
      ? { verifiedAt: max90dPoint.verifiedAt, sourceUrl: max90dPoint.sourceUrl }
      : null,
    average30d,
    sampleCount30d: points30d.length,
    sampleCount90d: comparable.length,
    observedFrom,
    observedTo,
    sampledPrices,
    sampledPricesTruncated: Math.max(0, points30d.length - sampledPrices.length),
    discountVsAverageBps:
      average30d && currentObservedPrice
        ? percentBps(average30d.amountMinor, currentObservedPrice.amountMinor)
        : null,
    discountVsHistoricalHighBps:
      observedMax90d && currentObservedPrice
        ? percentBps(observedMax90d.amountMinor, currentObservedPrice.amountMinor)
        : null,
    isRealDeal: decisionAllowed ? reason === "below_historical_average" : null,
    reason,
    comparableRule: `Same offer, marketplace, verified available price, seller, variation and currency; at least five 30-day samples spanning seven days; latest snapshot no older than ${input.offer.marketplace === "tiktok_shop" ? "24 hours" : "six hours"}; real deal means current price below the observed 30-day mean.`,
  };
};
