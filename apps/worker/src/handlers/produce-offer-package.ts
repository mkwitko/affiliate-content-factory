import {
  type OfferPackageDeps,
  produceOfferPackage,
} from "@money-maker/core/content/offer-package";
import { type JobIdentifierPayload, PermanentJobError } from "@money-maker/core/jobs/job";

/** produce_offer_package: thin adapter over the core use case (retry/permanent semantics live there). */
export const createProduceOfferPackageHandler =
  (deps: OfferPackageDeps) =>
  async (job: { payload: JobIdentifierPayload }): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    if (!identifiers.offerId) throw new PermanentJobError("offer_id_missing");
    const result = await produceOfferPackage(deps, { workspaceId, offerId: identifiers.offerId });
    console.info("offer_package_produced", {
      workspaceId,
      offerId: identifiers.offerId,
      contentItemId: result.contentItemId,
      created: result.created,
    });
  };
