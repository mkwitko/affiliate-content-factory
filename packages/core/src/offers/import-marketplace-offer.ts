import type { UserId, WorkspaceId } from "@money-maker/contracts";
import type { AuditPort } from "../audit/audit-port.js";
import { commercialFactsFromEvidence } from "./commercial-facts.js";
import { createOfferForWorkspace } from "./create-offer.js";
import type { MarketplaceCatalog, ProductEvidence } from "./marketplace-catalog.js";
import type { Offer } from "./offer.js";
import type { OfferRepository } from "./offer-repository.js";
import { addOfferEvidence } from "./review-offer.js";

export type ImportMarketplaceOfferDependencies = Readonly<{
  offers: OfferRepository;
  audit: AuditPort;
  /** Imports the official listing photos; stays injected because asset storage lives in the API app. */
  importPictures?: (input: {
    workspaceId: WorkspaceId;
    evidence: ProductEvidence;
  }) => Promise<readonly string[]>;
}>;

/**
 * Reads Mercado Livre evidence for a product and stores a draft offer with its verified
 * snapshot. Not idempotent: callers that must not duplicate offers look one up first.
 * Provider failures (for example `mercado_livre_not_connected`) propagate to the caller.
 */
export const importMarketplaceOffer = async (
  input: Readonly<{
    workspaceId: WorkspaceId;
    actorUserId: UserId;
    productId: string;
    affiliateUrl: string;
    catalog: Pick<MarketplaceCatalog, "readProductEvidence">;
  }>,
  dependencies: ImportMarketplaceOfferDependencies,
): Promise<{
  offer: Offer;
  evidence: ProductEvidence;
  pictureAssetIds: readonly string[];
}> => {
  const { workspaceId, actorUserId } = input;
  const evidence = await input.catalog.readProductEvidence(input.productId);
  const created = await createOfferForWorkspace(
    {
      workspaceId,
      marketplace: "mercado_livre",
      listingUrl: evidence.listingUrl.toString(),
      affiliateUrl: input.affiliateUrl,
      title: evidence.title,
      currentPrice: evidence.currentPrice,
      actorUserId,
    },
    dependencies,
  );
  const updated = await addOfferEvidence(
    {
      workspaceId,
      offerId: created.id,
      actorUserId,
      snapshot: {
        id: `ml-${evidence.providerId}-${evidence.observedAt.getTime()}`,
        verifiedAt: evidence.observedAt,
        facts: commercialFactsFromEvidence(evidence),
      },
    },
    dependencies,
  );
  const pictureAssetIds = (await dependencies.importPictures?.({ workspaceId, evidence })) ?? [];
  return { offer: updated ?? created, evidence, pictureAssetIds };
};
