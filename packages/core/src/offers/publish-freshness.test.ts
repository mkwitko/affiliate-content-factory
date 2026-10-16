import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { CommercialFact, CommercialSnapshot, Offer } from "./offer.js";
import type { ProductEvidence } from "./marketplace-catalog.js";
import { checkPublishFreshness, VOLATILE_FACT_KEYS } from "./publish-freshness.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const sourceUrl = "https://www.mercadolivre.com.br/p/MLB1";
const now = new Date("2026-09-25T10:00:00Z");
const fact = (key: string, value: CommercialFact["value"]): CommercialFact => ({
  key,
  value,
  sourceUrl,
  verified: true,
});
const facts = [
  fact("current_price", { amountMinor: 19700, currency: "BRL" }),
  fact("listing_status", "active"),
  fact("availability", "available"),
];
const snapshot: CommercialSnapshot = {
  id: "snapshot-1",
  verifiedAt: new Date("2026-09-25T09:00:00Z"),
  facts,
};
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: sourceUrl,
  affiliateUrl: "https://meli.la/a",
  title: "Product",
  state: "active",
  snapshots: [snapshot],
  activeSnapshotId: snapshot.id,
};
const evidence = (overrides: Partial<ProductEvidence> = {}): ProductEvidence => ({
  providerId: "MLB1",
  title: "Product",
  listingUrl: new URL(sourceUrl),
  seller: "seller",
  availability: "available",
  listingStatus: "active",
  currentPrice: { amountMinor: 19700, currency: "BRL" },
  observedAt: now,
  ...overrides,
});

describe("checkPublishFreshness", () => {
  it("passes when volatile facts match the cited snapshot", () => {
    expect(
      checkPublishFreshness({ offer, citedSnapshotId: snapshot.id, evidence: evidence(), now }).ok,
    ).toBe(true);
  });

  it("fails permanently when the refreshed listing is paused or closed", () => {
    for (const listingStatus of ["paused", "closed"] as const) {
      expect(
        checkPublishFreshness({
          offer,
          citedSnapshotId: snapshot.id,
          evidence: evidence({ listingStatus }),
          now,
        }),
      ).toMatchObject({ ok: false, reason: "listing_unavailable" });
    }
  });

  it("fails when the refreshed listing is out of stock", () => {
    expect(
      checkPublishFreshness({
        offer,
        citedSnapshotId: snapshot.id,
        evidence: evidence({ availability: "out_of_stock" }),
        now,
      }),
    ).toMatchObject({ ok: false, reason: "listing_unavailable" });
  });

  it("fails and names volatile facts that changed", () => {
    expect(
      checkPublishFreshness({
        offer,
        citedSnapshotId: snapshot.id,
        evidence: evidence({ currentPrice: { amountMinor: 21900, currency: "BRL" } }),
        now,
      }),
    ).toMatchObject({ ok: false, reason: "cited_fact_changed", changedKeys: ["current_price"] });
  });

  it("fails when a stale snapshot cannot be refreshed", () => {
    expect(
      checkPublishFreshness({
        offer,
        citedSnapshotId: snapshot.id,
        evidence: null,
        now: new Date("2026-09-25T16:00:01Z"),
      }),
    ).toMatchObject({ ok: false, reason: "evidence_unverifiable" });
  });

  it("accepts a snapshot younger than six hours without another catalog read", () => {
    expect(
      checkPublishFreshness({
        offer,
        citedSnapshotId: snapshot.id,
        evidence: null,
        now: new Date("2026-09-25T12:00:00Z"),
      }).ok,
    ).toBe(true);
  });

  it("blocks a listing already marked unavailable by the cited snapshot", () => {
    const unavailable: Offer = {
      ...offer,
      snapshots: [
        {
          ...snapshot,
          facts: [fact("listing_status", "paused"), fact("availability", false)],
        },
      ],
    };
    expect(
      checkPublishFreshness({
        offer: unavailable,
        citedSnapshotId: snapshot.id,
        evidence: null,
        now,
      }),
    ).toMatchObject({ ok: false, reason: "listing_unavailable" });
  });

  it("lists every volatile fact compared before publishing", () => {
    expect(VOLATILE_FACT_KEYS).toEqual([
      "current_price",
      "list_price",
      "discount_percent",
      "availability",
      "listing_status",
      "rating_average",
      "review_count",
      "free_shipping",
    ]);
  });
});
