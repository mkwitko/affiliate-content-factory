import type { UserId } from "@money-maker/contracts";
import type { AuditPort } from "../audit/audit-port.js";
import {
  activateOffer as activateOfferDomain,
  addEvidenceSnapshot,
  addRefreshedSnapshot,
  rejectOffer,
} from "./offer.js";
import type { CommercialSnapshot, Offer } from "./offer.js";
import type { OfferRepository } from "./offer-repository.js";

export type ReviewOfferDependencies = Readonly<{
  offers: OfferRepository;
  audit: AuditPort;
}>;

export const addOfferEvidence = async (
  input: Readonly<{
    workspaceId: Offer["workspaceId"];
    offerId: string;
    actorUserId: UserId;
    snapshot: CommercialSnapshot;
  }>,
  dependencies: ReviewOfferDependencies,
): Promise<Offer | null> => {
  const offer = await dependencies.offers.findForWorkspace(input);
  if (!offer) return null;
  const updated = addEvidenceSnapshot(offer, input.snapshot);
  const stored = await dependencies.offers.addSnapshot({
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    snapshot: input.snapshot,
  });
  if (!stored) return null;
  await dependencies.audit.record({
    action: "offer.evidence.added",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    targetType: "Offer",
    targetId: input.offerId,
    metadata: {
      snapshotId: input.snapshot.id,
      factCount: updated.snapshots.at(-1)?.facts.length ?? 0,
    },
  });
  return stored;
};

/**
 * Adds a system-observed snapshot to an already-known offer: like `addOfferEvidence`, but a
 * volatile fact (price, commission, stock) may legitimately differ from earlier evidence without
 * being treated as a conflict (`addRefreshedSnapshot`). Used by `import_tiktok_shop_product` when
 * the operator re-observes a product it already imported.
 */
export const refreshOfferEvidence = async (
  input: Readonly<{
    workspaceId: Offer["workspaceId"];
    offerId: string;
    actorUserId: UserId;
    snapshot: CommercialSnapshot;
  }>,
  dependencies: ReviewOfferDependencies,
): Promise<Offer | null> => {
  const offer = await dependencies.offers.findForWorkspace(input);
  if (!offer) return null;
  const updated = addRefreshedSnapshot(offer, input.snapshot);
  const stored = await dependencies.offers.addSnapshot({
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    snapshot: input.snapshot,
  });
  if (!stored) return null;
  await dependencies.audit.record({
    action: "offer.evidence.added",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    targetType: "Offer",
    targetId: input.offerId,
    metadata: {
      snapshotId: input.snapshot.id,
      factCount: updated.snapshots.at(-1)?.facts.length ?? 0,
    },
  });
  return stored;
};

export const activateOfferForWorkspace = async (
  input: Readonly<{
    workspaceId: Offer["workspaceId"];
    offerId: string;
    actorUserId: UserId;
    now?: Date;
  }>,
  dependencies: ReviewOfferDependencies,
): Promise<Offer | null> => {
  const offer = await dependencies.offers.findForWorkspace(input);
  if (!offer) return null;
  const active = activateOfferDomain(offer, input.now);
  const stored = await dependencies.offers.activate({
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    snapshotId: active.activeSnapshotId ?? "",
  });
  if (!stored) return null;
  await dependencies.audit.record({
    action: "offer.activated",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    targetType: "Offer",
    targetId: input.offerId,
    metadata: { snapshotId: active.activeSnapshotId ?? null },
  });
  return stored;
};

export const rejectOfferForWorkspace = async (
  input: Readonly<{
    workspaceId: Offer["workspaceId"];
    offerId: string;
    actorUserId: UserId;
    reason: string;
  }>,
  dependencies: ReviewOfferDependencies,
): Promise<Offer | null> => {
  const offer = await dependencies.offers.findForWorkspace(input);
  if (!offer) return null;
  const rejected = rejectOffer(offer, input.reason);
  const stored = await dependencies.offers.reject({
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    reason: rejected.rejectionReason ?? input.reason,
  });
  if (!stored) return null;
  await dependencies.audit.record({
    action: "offer.rejected",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    targetType: "Offer",
    targetId: input.offerId,
  });
  return stored;
};
