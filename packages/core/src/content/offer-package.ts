import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AuditPort } from "../audit/audit-port.js";
import {
  createDraftOfferCopyJob,
  type JobQueue,
  PermanentJobError,
  RetryLaterJobError,
} from "../jobs/job.js";
import { commercialFactsFromEvidence } from "../offers/commercial-facts.js";
import type { MarketplaceCatalog } from "../offers/marketplace-catalog.js";
import {
  activateOffer,
  addRefreshedSnapshot,
  type CommercialSnapshot,
  type Offer,
  productIdFromOffer,
} from "../offers/offer.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import type { ProductCandidateRepository } from "../research/product-candidate-repository.js";
import { createContentItem } from "./content.js";
import type { ContentRepository } from "./content-repository.js";

/** Recorded as the audit actor when packaging activates an offer without a human session. */
export const SYSTEM_OFFER_PACKAGE_ACTOR = "system:offer-package";
export const OFFER_PACKAGE_RETRY_MS = 30 * 60 * 1000;
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Deterministic RFC 4122 UUID (version nibble 8, RFC variant) from a key, so ids survive re-runs. */
export const uuidFromKey = (key: string): string => {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The content item produce_offer_package made for an offer (no human picked its slides). */
export const isAutoSaleItem = (item: Readonly<{ id: string; offerId: string | null }>): boolean =>
  item.offerId !== null && item.id === uuidFromKey(`auto-sale:${item.offerId}`);

export type OfferPackageDeps = Readonly<{
  offers: OfferRepository;
  audit: AuditPort;
  content: Pick<ContentRepository, "findContentItemForWorkspace" | "createContentItem">;
  candidates: Pick<ProductCandidateRepository, "findByOffer" | "transition">;
  assets: Pick<AssetRepository, "listByMetadata">;
  jobs: Pick<JobQueue, "enqueue">;
  catalogForWorkspace: (workspaceId: WorkspaceId) => MarketplaceCatalog | undefined;
  now: () => Date;
}>;

const retryLater = (message: string, now: Date) =>
  new RetryLaterJobError(message, new Date(now.getTime() + OFFER_PACKAGE_RETRY_MS));

/**
 * Evidence older than a day (or a draft offer) is re-read from the marketplace and the offer is
 * activated on the fresh snapshot. Provider failures retry later; a changed identity is permanent.
 */
const ensureFreshActiveOffer = async (deps: OfferPackageDeps, offer: Offer): Promise<Offer> => {
  const now = deps.now();
  const current = offer.snapshots.find((snapshot) => snapshot.id === offer.activeSnapshotId);
  if (
    offer.state === "active" &&
    current &&
    now.getTime() - current.verifiedAt.getTime() <= EVIDENCE_MAX_AGE_MS
  )
    return offer;
  const productId = productIdFromOffer(offer);
  const catalog = deps.catalogForWorkspace(offer.workspaceId);
  if (!productId || !catalog) throw new PermanentJobError("offer_not_active");
  let snapshot: CommercialSnapshot;
  try {
    const evidence = await catalog.readProductEvidence(productId);
    if (evidence.title !== offer.title) throw new PermanentJobError("offer_identity_changed");
    snapshot = {
      id: `refresh-${offer.id}-${evidence.observedAt.getTime()}`,
      verifiedAt: evidence.observedAt,
      facts: commercialFactsFromEvidence(evidence),
    };
  } catch (error) {
    if (error instanceof PermanentJobError) throw error;
    throw retryLater("offer_refresh_failed", now);
  }
  let active: Offer;
  try {
    active = activateOffer(addRefreshedSnapshot(offer, snapshot), now);
  } catch {
    throw new PermanentJobError("offer_not_active");
  }
  const stored =
    (await deps.offers.addSnapshot({
      workspaceId: offer.workspaceId,
      offerId: offer.id,
      snapshot,
    })) &&
    (await deps.offers.activate({
      workspaceId: offer.workspaceId,
      offerId: offer.id,
      snapshotId: snapshot.id,
    }));
  if (!stored) throw new PermanentJobError("offer_not_active");
  await deps.audit.record({
    action: "offer.activated",
    workspaceId: offer.workspaceId,
    systemActor: SYSTEM_OFFER_PACKAGE_ACTOR,
    targetType: "Offer",
    targetId: offer.id,
    metadata: { snapshotId: snapshot.id },
  });
  return stored.state === "active" ? stored : active;
};

/**
 * produce_offer_package: a linked, qualified candidate's offer becomes one draft content item
 * (deterministic id, so re-runs reuse it) and a `draft_offer_copy` job. Never approves or publishes.
 */
export const produceOfferPackage = async (
  deps: OfferPackageDeps,
  input: Readonly<{ workspaceId: WorkspaceId; offerId: string }>,
): Promise<Readonly<{ contentItemId: string; created: boolean }>> => {
  const { workspaceId, offerId } = input;
  const found = await deps.offers.findForWorkspace({ workspaceId, offerId });
  if (!found || found.state === "archived" || found.state === "rejected")
    throw new PermanentJobError("offer_not_active");
  const candidate = await deps.candidates.findByOffer({ workspaceId, offerId });
  if (!candidate) throw new PermanentJobError("candidate_not_found");
  if (!["linked", "in_production"].includes(candidate.state))
    throw new PermanentJobError("candidate_not_linked");

  const offer = await ensureFreshActiveOffer(deps, found);
  const snapshot = offer.snapshots.find((entry) => entry.id === offer.activeSnapshotId);
  if (offer.state !== "active" || !snapshot) throw new PermanentJobError("offer_not_active");

  const contentItemId = uuidFromKey(`auto-sale:${offerId}`);
  const existing = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId,
  });
  if (!existing) {
    const productId = productIdFromOffer(offer);
    const pictures = productId
      ? await deps.assets.listByMetadata?.({
          workspaceId,
          role: "listing_picture",
          key: "productId",
          value: productId,
        })
      : [];
    if (!pictures?.length) throw new PermanentJobError("listing_pictures_missing");
    await deps.content.createContentItem(
      createContentItem({
        id: contentItemId,
        workspaceId,
        nicheId: candidate.nicheId,
        offer,
        title: `Auto · Venda · ${offer.title.slice(0, 80)}`,
        sourceFactKeys: snapshot.facts.filter((fact) => fact.verified).map((fact) => fact.key),
        sourcePictureAssetIds: pictures.map((asset) => asset.id),
        creativeOpinion:
          candidate.qualification?.reasons.join("; ").slice(0, 500) || "Qualified candidate",
      }),
    );
  }
  await deps.jobs.enqueue(createDraftOfferCopyJob({ workspaceId, contentItemId }));
  if (candidate.state === "linked")
    await deps.candidates.transition({
      workspaceId,
      id: candidate.id,
      from: ["linked"],
      to: "in_production",
      at: deps.now(),
    });
  return { contentItemId, created: !existing };
};
