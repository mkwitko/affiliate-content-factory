import { describe, expect, it } from "vitest";
import { PRODUCT_POST_COOLDOWN_DAYS, isProductInCooldown } from "./product-posting-history.js";

describe("isProductInCooldown", () => {
  const now = new Date("2026-09-24T00:00:00.000Z");

  it("keeps a product in cooldown before it elapses", () => {
    const lastPublishedAt = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    expect(isProductInCooldown(lastPublishedAt, now)).toBe(true);
  });

  it("clears the cooldown once it has fully elapsed", () => {
    const lastPublishedAt = new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000);
    expect(isProductInCooldown(lastPublishedAt, now)).toBe(false);
  });

  it("uses the owner-set 21 day default", () => {
    expect(PRODUCT_POST_COOLDOWN_DAYS).toBe(21);
  });
});
