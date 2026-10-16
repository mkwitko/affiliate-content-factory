import { describe, expect, it } from "vitest";
import { PRODUCT_CANDIDATE_STATES, transitionCandidate } from "./product-candidate.js";

describe("transitionCandidate", () => {
  it.each([
    ["awaiting_affiliate_link", "linked"],
    ["linked", "in_production"],
    ["in_production", "consumed"],
    ["linked", "awaiting_affiliate_link"],
    ["discovered", "awaiting_affiliate_link"],
    ["discovered", "rejected"],
    ["discovered", "duplicate"],
    ["awaiting_affiliate_link", "expired"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(transitionCandidate(from, to)).toBe(true);
  });

  it.each([
    ["rejected", "linked"],
    ["awaiting_affiliate_link", "in_production"],
    ["linked", "discovered"],
  ] as const)("forbids %s -> %s", (from, to) => {
    expect(transitionCandidate(from, to)).toBe(false);
  });

  it("treats consumed as terminal", () => {
    for (const to of PRODUCT_CANDIDATE_STATES)
      expect(transitionCandidate("consumed", to)).toBe(false);
  });
});
