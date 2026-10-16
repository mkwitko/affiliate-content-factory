import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Offer } from "./offer.js";
import type { OfferRepository } from "./offer-repository.js";
import type { ProductEvidence } from "./marketplace-catalog.js";
import { importMarketplaceOffer } from "./import-marketplace-offer.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const actorUserId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const evidence: ProductEvidence = {
  providerId: "MLB777",
  title: "Suporte de notebook",
  listingUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
  seller: "Loja",
  availability: "available",
  listingStatus: "active",
  currentPrice: { amountMinor: 2290, currency: "BRL" },
  observedAt: new Date("2026-09-23T10:00:00Z"),
};

const repository = () => {
  const stored: Offer[] = [];
  const offers = {
    create: async (offer: Offer) => {
      stored.push(offer);
      return offer;
    },
    findForWorkspace: async ({ offerId }: { offerId: string }) =>
      stored.find((offer) => offer.id === offerId) ?? null,
    addSnapshot: async ({
      offerId,
      snapshot,
    }: {
      offerId: string;
      snapshot: Offer["snapshots"][number];
    }) => {
      const index = stored.findIndex((offer) => offer.id === offerId);
      const current = stored[index];
      if (!current) return null;
      const next = { ...current, snapshots: [...current.snapshots, snapshot] };
      stored[index] = next;
      return next;
    },
  } as unknown as OfferRepository;
  return { offers, stored };
};

describe("importMarketplaceOffer", () => {
  it("creates a draft offer with the evidence snapshot and audits both steps", async () => {
    const { offers, stored } = repository();
    const audit = { record: vi.fn(async (_event: { action: string }) => "audit") };
    const result = await importMarketplaceOffer(
      {
        workspaceId,
        actorUserId,
        productId: "MLB777",
        affiliateUrl: "https://meli.la/abc",
        catalog: { readProductEvidence: async () => evidence },
      },
      { offers, audit },
    );
    expect(stored).toHaveLength(1);
    expect(result.offer).toMatchObject({
      affiliateUrl: "https://meli.la/abc",
      state: "draft",
      snapshots: [{ id: `ml-MLB777-${evidence.observedAt.getTime()}` }],
    });
    expect(result.evidence).toBe(evidence);
    expect(result.pictureAssetIds).toEqual([]);
    expect(audit.record.mock.calls.map(([event]) => event.action)).toEqual([
      "offer.created",
      "offer.evidence.added",
    ]);
  });

  it("collects picture ids from the injected importer", async () => {
    const importPictures = vi.fn(async () => ["asset-1", "asset-2"]);
    const result = await importMarketplaceOffer(
      {
        workspaceId,
        actorUserId,
        productId: "MLB777",
        affiliateUrl: "https://meli.la/abc",
        catalog: { readProductEvidence: async () => evidence },
      },
      { offers: repository().offers, audit: { record: async () => "audit" }, importPictures },
    );
    expect(importPictures).toHaveBeenCalledWith({ workspaceId, evidence });
    expect(result.pictureAssetIds).toEqual(["asset-1", "asset-2"]);
  });

  it("propagates provider failures without creating an offer", async () => {
    const { offers, stored } = repository();
    await expect(
      importMarketplaceOffer(
        {
          workspaceId,
          actorUserId,
          productId: "MLB777",
          affiliateUrl: "https://meli.la/abc",
          catalog: {
            readProductEvidence: async () => {
              throw new Error("mercado_livre_not_connected");
            },
          },
        },
        { offers, audit: { record: async () => "audit" } },
      ),
    ).rejects.toThrow("mercado_livre_not_connected");
    expect(stored).toHaveLength(0);
  });
});
