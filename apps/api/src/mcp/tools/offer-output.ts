import type { Offer } from "@money-maker/core/offers/offer";

/**
 * Offers are refreshed several times a day and keep every snapshot (183 on one offer by
 * 2026-10-15, 1.4 MB for list_offers). Tools show the active snapshot, or the newest when none
 * is active; analyze_offer_price_history reads the history.
 */
const shownSnapshots = (offer: Offer) => {
  const active = offer.snapshots.find((snapshot) => snapshot.id === offer.activeSnapshotId);
  const newest = offer.snapshots.reduce<Offer["snapshots"][number] | undefined>(
    (latest, snapshot) => (!latest || snapshot.verifiedAt > latest.verifiedAt ? snapshot : latest),
    undefined,
  );
  const shown = active ?? newest;
  return shown ? [shown] : [];
};

export const publicOffer = (offer: Offer) => ({
  id: offer.id,
  title: offer.title,
  state: offer.state,
  listingUrl: offer.listingUrl,
  affiliateUrl: offer.affiliateUrl ?? null,
  currentPrice: offer.currentPrice ?? null,
  activeSnapshotId: offer.activeSnapshotId ?? null,
  snapshotCount: offer.snapshots.length,
  snapshots: shownSnapshots(offer).map((snapshot) => ({
    id: snapshot.id,
    verifiedAt: snapshot.verifiedAt.toISOString(),
    facts: snapshot.facts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      sourceUrl: fact.sourceUrl,
      verified: fact.verified,
    })),
  })),
});
