import { describe, expect, it } from "vitest";
import type { CommercialFact } from "../offers/offer.js";
import { formatMoney, priceBadgeText, priceDisplayFromFacts } from "./price-display.js";

const snapshot = { id: "snap", verifiedAt: new Date("2026-10-01T10:00:00Z") };
const money = (amountMinor: number) => ({ amountMinor, currency: "BRL" });
const fact = (key: string, value: CommercialFact["value"], verified = true): CommercialFact => ({
  key,
  value,
  sourceUrl: "https://x.test",
  verified,
});

describe("priceDisplayFromFacts", () => {
  it("computes discount and free shipping from verified facts", () => {
    const display = priceDisplayFromFacts(
      [
        fact("current_price", money(3685)),
        fact("list_price", money(4990)),
        fact("free_shipping", true),
      ],
      snapshot,
    );
    expect(display).toEqual({
      current: money(3685),
      original: money(4990),
      discountPct: 26,
      freeShipping: true,
      source: {
        factKeys: ["current_price", "list_price", "free_shipping"],
        snapshotId: "snap",
        verifiedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    expect(display && priceBadgeText(display)).toBe("De R$ 49,90 por R$ 36,85");
  });
  it("returns null without a verified current price", () => {
    expect(priceDisplayFromFacts([], snapshot)).toBeNull();
    expect(priceDisplayFromFacts([fact("current_price", money(100), false)], snapshot)).toBeNull();
    expect(priceDisplayFromFacts([fact("current_price", "R$ 10")], snapshot)).toBeNull();
  });
  it("omits the original price when unverified, equal or lower", () => {
    for (const list of [
      fact("list_price", money(4990), false),
      fact("list_price", money(3685)),
      fact("list_price", money(1000)),
    ]) {
      const display = priceDisplayFromFacts([fact("current_price", money(3685)), list], snapshot);
      expect(display?.original).toBeUndefined();
      expect(display?.discountPct).toBeUndefined();
      expect(display?.source.factKeys).toEqual(["current_price"]);
    }
  });
  it("shows free shipping only when verified true", () => {
    const base = fact("current_price", money(3685));
    expect(
      priceDisplayFromFacts([base, fact("free_shipping", true, false)], snapshot)?.freeShipping,
    ).toBeUndefined();
    expect(
      priceDisplayFromFacts([base, fact("free_shipping", false)], snapshot)?.freeShipping,
    ).toBeUndefined();
  });
  it("floors the discount", () => {
    const d = priceDisplayFromFacts(
      [fact("current_price", money(6667)), fact("list_price", money(10000))],
      snapshot,
    );
    expect(d?.discountPct).toBe(33);
  });
});

describe("formatMoney", () => {
  it("formats pt-BR amounts", () => {
    expect(formatMoney(money(3685))).toBe("R$ 36,85");
    expect(formatMoney(money(123456))).toBe("R$ 1.234,56");
    expect(formatMoney(money(5))).toBe("R$ 0,05");
    expect(formatMoney(money(100000000))).toBe("R$ 1.000.000,00");
  });
});
