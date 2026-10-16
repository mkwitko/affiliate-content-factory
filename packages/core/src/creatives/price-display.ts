import type { CommercialFact, CommercialSnapshot, Money } from "../offers/offer.js";

/** Computed from verified offer facts, never from copy text. */
export type PriceDisplay = Readonly<{
  current: Money;
  /** Only when list_price and current_price are both verified and list > current. */
  original?: Money;
  discountPct?: number;
  /** Only when free_shipping is a verified `true`. */
  freeShipping?: true;
  source: Readonly<{ factKeys: readonly string[]; snapshotId: string; verifiedAt: string }>;
}>;

const isMoney = (value: unknown): value is Money =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as Money).amountMinor) &&
  (value as Money).amountMinor > 0 &&
  typeof (value as Money).currency === "string";
const verifiedMoney = (facts: readonly CommercialFact[], key: string): Money | undefined => {
  const fact = facts.find((candidate) => candidate.key === key);
  return fact?.verified && isMoney(fact.value) ? fact.value : undefined;
};

export const priceDisplayFromFacts = (
  facts: readonly CommercialFact[],
  snapshot: Pick<CommercialSnapshot, "id" | "verifiedAt">,
): PriceDisplay | null => {
  const current = verifiedMoney(facts, "current_price");
  if (!current) return null;
  const factKeys = ["current_price"];
  const list = verifiedMoney(facts, "list_price");
  const discounted =
    list && list.currency === current.currency && list.amountMinor > current.amountMinor
      ? list
      : undefined;
  if (discounted) factKeys.push("list_price");
  const shipping = facts.find((fact) => fact.key === "free_shipping");
  const freeShipping = shipping?.verified === true && shipping.value === true;
  if (freeShipping) factKeys.push("free_shipping");
  return {
    current,
    ...(discounted
      ? {
          original: discounted,
          discountPct: Math.floor(
            ((discounted.amountMinor - current.amountMinor) / discounted.amountMinor) * 100,
          ),
        }
      : {}),
    ...(freeShipping ? { freeShipping: true as const } : {}),
    source: { factKeys, snapshotId: snapshot.id, verifiedAt: snapshot.verifiedAt.toISOString() },
  };
};

/** "R$ 1.234,56"; other currencies print their code. */
export const formatMoney = (money: Money): string => {
  const major = Math.floor(money.amountMinor / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = String(money.amountMinor % 100).padStart(2, "0");
  return `${money.currency === "BRL" ? "R$" : money.currency} ${major},${cents}`;
};

/** Pill text the in-scene overlay draws: "De R$ X por R$ Y" or just the current price. */
export const priceBadgeText = (price: PriceDisplay): string =>
  price.original
    ? `De ${formatMoney(price.original)} por ${formatMoney(price.current)}`
    : formatMoney(price.current);
