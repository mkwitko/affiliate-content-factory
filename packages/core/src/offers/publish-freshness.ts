import type { CommercialFactValue, CommercialSnapshot, Offer } from "./offer.js";
import { commercialFactsFromEvidence } from "./commercial-facts.js";
import type { ProductEvidence } from "./marketplace-catalog.js";

export const VOLATILE_FACT_KEYS = [
  "current_price",
  "list_price",
  "discount_percent",
  "availability",
  "listing_status",
  "rating_average",
  "review_count",
  "free_shipping",
] as const;
export const PUBLISH_MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

export type FreshnessVerdict =
  | Readonly<{ ok: true; snapshot: CommercialSnapshot }>
  | Readonly<{
      ok: false;
      reason: "listing_unavailable" | "cited_fact_changed" | "evidence_unverifiable";
      changedKeys?: readonly string[];
    }>;

const valueFor = (
  facts: readonly { key: string; value: CommercialFactValue }[],
  key: string,
): CommercialFactValue | undefined => facts.find((fact) => fact.key === key)?.value;

const same = (left: CommercialFactValue, right: CommercialFactValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isAvailable = (value: CommercialFactValue | undefined): boolean =>
  value === "available" || value === "in_stock" || value === true;

export const checkPublishFreshness = (
  input: Readonly<{
    offer: Offer;
    citedSnapshotId: string;
    evidence: ProductEvidence | null;
    now: Date;
  }>,
): FreshnessVerdict => {
  const cited = input.offer.snapshots.find((snapshot) => snapshot.id === input.citedSnapshotId);
  if (!cited) return { ok: false, reason: "evidence_unverifiable" };

  const citedStatus = valueFor(cited.facts, "listing_status");
  const citedAvailability = valueFor(cited.facts, "availability");
  if (
    (citedStatus !== undefined && citedStatus !== "active") ||
    (citedAvailability !== undefined && !isAvailable(citedAvailability))
  ) {
    return { ok: false, reason: "listing_unavailable" };
  }

  if (!input.evidence) {
    const ageMs = input.now.getTime() - cited.verifiedAt.getTime();
    return ageMs >= 0 && ageMs <= PUBLISH_MAX_SNAPSHOT_AGE_MS
      ? { ok: true, snapshot: cited }
      : { ok: false, reason: "evidence_unverifiable" };
  }

  if (input.evidence.listingStatus !== "active" || !isAvailable(input.evidence.availability)) {
    return { ok: false, reason: "listing_unavailable" };
  }

  const freshFacts = commercialFactsFromEvidence(input.evidence);
  const changedKeys: string[] = [];
  for (const key of VOLATILE_FACT_KEYS) {
    const previous = valueFor(cited.facts, key);
    if (previous === undefined) continue;
    const current = valueFor(freshFacts, key);
    if (current === undefined) return { ok: false, reason: "evidence_unverifiable" };
    if (!same(previous, current)) changedKeys.push(key);
  }
  if (changedKeys.length) return { ok: false, reason: "cited_fact_changed", changedKeys };

  return {
    ok: true,
    snapshot: {
      id: `publish-${input.offer.id}-${input.evidence.observedAt.getTime()}`,
      verifiedAt: input.evidence.observedAt,
      facts: freshFacts,
    },
  };
};
