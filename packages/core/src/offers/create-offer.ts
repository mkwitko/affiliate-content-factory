import type { UserId } from "@money-maker/contracts";
import type { AuditPort } from "../audit/audit-port.js";
import { createOffer as createOfferDomain, type CreateOfferInput, type Offer } from "./offer.js";
import type { OfferRepository } from "./offer-repository.js";

export type CreateOfferDependencies = Readonly<{
  offers: OfferRepository;
  audit: AuditPort;
}>;

export const createOfferForWorkspace = async (
  input: CreateOfferInput & Readonly<{ actorUserId: UserId }>,
  dependencies: CreateOfferDependencies,
): Promise<Offer> => {
  const offer = createOfferDomain(input);
  const stored = await dependencies.offers.create(offer);
  await dependencies.audit.record({
    action: "offer.created",
    workspaceId: offer.workspaceId,
    actorUserId: input.actorUserId,
    targetType: "Offer",
    targetId: offer.id,
    metadata: { marketplace: offer.marketplace },
  });
  return stored;
};
