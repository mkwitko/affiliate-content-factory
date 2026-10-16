import type { WorkspaceId } from "@money-maker/contracts";
import type { AuditPort } from "../audit/audit-port.js";
import { addRefreshedSnapshot, productIdFromOffer } from "./offer.js";
import type { CommercialSnapshot, Offer } from "./offer.js";
import { commercialFactsFromEvidence } from "./commercial-facts.js";
import type { MarketplaceCatalog } from "./marketplace-catalog.js";
import type { OfferRepository } from "./offer-repository.js";

/** Recorded as the audit actor: this transition has no human session behind it. */
export const SYSTEM_OFFER_REFRESH_ACTOR = "system:offer-refresh";

export type OfferRefreshSkipReason =
  | "catalog_unavailable"
  | "product_id_unresolved"
  | "identity_conflict"
  | string;

export type RefreshOffersDependencies = Readonly<{
  // `listActive` is optional on the general repository interface (most callers are workspace
  // scoped); the refresh loop is the one caller that needs it, so it is required here.
  offers: OfferRepository & Readonly<{ listActive: NonNullable<OfferRepository["listActive"]> }>;
  audit: AuditPort;
  marketplaceCatalogForWorkspace: (workspaceId: WorkspaceId) => MarketplaceCatalog | undefined;
  now?: () => Date;
  /** A small pause between offers, gentle on the marketplace API; 0/undefined skips it. */
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onSkipped?: (
    input: Readonly<{ offerId: string; workspaceId: WorkspaceId; reason: OfferRefreshSkipReason }>,
  ) => void;
}>;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Mercado Livre reports a delisted or out-of-stock item by throwing before any evidence comes back. */
const isUnavailableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.message === "listing_unavailable" || error.message === "no_active_offer") return true;
  // ponytail: duck-typed status check — core cannot import the providers-only error class.
  return (error as { status?: unknown }).status === 404;
};

const unavailableSnapshot = (offer: Offer, observedAt: Date): CommercialSnapshot => ({
  id: `refresh-${offer.id}-${observedAt.getTime()}`,
  verifiedAt: observedAt,
  facts: [{ key: "availability", value: false, sourceUrl: offer.listingUrl, verified: true }],
});

const refreshOneOffer = async (
  offer: Offer,
  dependencies: RefreshOffersDependencies,
): Promise<void> => {
  const skip = (reason: OfferRefreshSkipReason) =>
    dependencies.onSkipped?.({ offerId: offer.id, workspaceId: offer.workspaceId, reason });

  // TikTok Shop has no automatic catalog re-verification (manual pilot, design §12): only
  // Mercado Livre offers refresh here.
  if (offer.marketplace !== "mercado_livre") return skip("marketplace_unsupported");
  const catalog = dependencies.marketplaceCatalogForWorkspace(offer.workspaceId);
  if (!catalog) return skip("catalog_unavailable");
  const productId = productIdFromOffer(offer);
  if (!productId) return skip("product_id_unresolved");

  let snapshot: CommercialSnapshot;
  try {
    const evidence = await catalog.readProductEvidence(productId);
    // Identity facts (title, seller — the item id is invariant by construction, since it is the
    // id we just queried) must still match; a real identity change is a conflict, not a refresh.
    if (evidence.title !== offer.title) return skip("identity_conflict");
    snapshot = {
      id: `refresh-${offer.id}-${evidence.observedAt.getTime()}`,
      verifiedAt: evidence.observedAt,
      facts: commercialFactsFromEvidence(evidence),
    };
  } catch (error) {
    if (!isUnavailableError(error)) {
      return skip(error instanceof Error ? error.message : "unknown_error");
    }
    snapshot = unavailableSnapshot(offer, (dependencies.now ?? (() => new Date()))());
  }

  try {
    addRefreshedSnapshot(offer, snapshot);
  } catch {
    return skip("identity_conflict");
  }

  const stored = await dependencies.offers.addSnapshot({
    workspaceId: offer.workspaceId,
    offerId: offer.id,
    snapshot,
  });
  if (!stored) return;
  const activated = await dependencies.offers.activate({
    workspaceId: offer.workspaceId,
    offerId: offer.id,
    snapshotId: snapshot.id,
  });
  if (!activated) return;
  await dependencies.audit.record({
    action: "offer.activated",
    workspaceId: offer.workspaceId,
    systemActor: SYSTEM_OFFER_REFRESH_ACTOR,
    targetType: "Offer",
    targetId: offer.id,
    metadata: { snapshotId: snapshot.id },
  });
};

/**
 * Refreshes every ACTIVE offer's commercial snapshot from its marketplace, one workspace's
 * catalog at a time, serially. Every refresh writes a brand-new snapshot and makes it active —
 * even when nothing changed, so `verifiedAt` stays current for the storefront's 24-hour freshness
 * rule — except an identity conflict (title/seller no longer match) or a provider failure, which
 * skip only that offer and never stop the sweep.
 */
export const refreshActiveOffers = async (
  dependencies: RefreshOffersDependencies,
): Promise<void> => {
  const sleep = dependencies.sleep ?? defaultSleep;
  const offers = await dependencies.offers.listActive();
  for (let index = 0; index < offers.length; index += 1) {
    if (index > 0 && dependencies.delayMs) await sleep(dependencies.delayMs);
    await refreshOneOffer(offers[index] as Offer, dependencies);
  }
};
