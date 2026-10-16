import { parseWorkspaceId } from "@money-maker/contracts";
import { PermanentJobError } from "@money-maker/core/jobs/job";
import { describe, expect, it } from "vitest";
import { createProduceOfferPackageHandler } from "./produce-offer-package.js";

const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");

describe("produce_offer_package handler", () => {
  it("fails permanently without an offer id and when the offer is gone", async () => {
    const handler = createProduceOfferPackageHandler({
      offers: { findForWorkspace: async () => null },
    } as never);
    await expect(
      handler({ payload: { version: 1, workspaceId, identifiers: { other: workspaceId } } }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      handler({ payload: { version: 1, workspaceId, identifiers: { offerId: workspaceId } } }),
    ).rejects.toMatchObject({ reason: "offer_not_active" });
  });
});
