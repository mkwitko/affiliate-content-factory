import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import { PermanentJobError, RetryLaterJobError } from "../jobs/job.js";
import type { MarketplaceCatalog } from "../offers/marketplace-catalog.js";
import type { Offer } from "../offers/offer.js";
import type { ProductCandidate } from "../research/product-candidate.js";
import type { ContentItem } from "./content.js";
import { type OfferPackageDeps, produceOfferPackage, uuidFromKey } from "./offer-package.js";

const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const offerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = new Date("2026-10-02T12:00:00.000Z");
const fact = (key: string, value: unknown) => ({
  key,
  value,
  sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
  verified: true,
});
const baseOffer = (over: Partial<Offer> = {}): Offer =>
  ({
    id: offerId,
    workspaceId,
    marketplace: "mercado_livre",
    listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
    affiliateUrl: "https://meli.la/abc",
    title: "Produto",
    state: "active",
    activeSnapshotId: "s1",
    snapshots: [
      {
        id: "s1",
        verifiedAt: new Date(now.getTime() - 60_000),
        facts: [fact("current_price", { amountMinor: 1000, currency: "BRL" }), fact("seller", "X")],
      },
    ],
    ...over,
  }) as unknown as Offer;
const candidate = (state: ProductCandidate["state"] = "linked") =>
  ({
    id: "cand-1",
    workspaceId,
    nicheId: "niche-1",
    offerId,
    state,
    qualification: { reasons: ["good rating"] },
  }) as unknown as ProductCandidate;

const setup = (
  over: {
    offer?: Offer | null;
    candidate?: ProductCandidate | null;
    pictures?: readonly string[];
    catalog?: Partial<MarketplaceCatalog>;
  } = {},
) => {
  let offer: Offer | null = over.offer === undefined ? baseOffer() : over.offer;
  const items = new Map<string, ContentItem>();
  const cand = over.candidate === undefined ? candidate() : over.candidate;
  const transition = vi.fn(async () => cand);
  const enqueue = vi.fn(async () => ({ id: "j" }));
  const readProductEvidence = vi.fn(async () => ({
    providerId: "MLB1",
    title: "Produto",
    listingUrl: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    seller: "X",
    availability: "ok",
    listingStatus: "active" as const,
    currentPrice: { amountMinor: 900, currency: "BRL" },
    observedAt: now,
  }));
  const deps = {
    offers: {
      findForWorkspace: async () => offer,
      addSnapshot: vi.fn(async ({ snapshot }) => {
        offer = offer && { ...offer, snapshots: [...offer.snapshots, snapshot] };
        return offer;
      }),
      activate: vi.fn(async ({ snapshotId }) => {
        offer = offer && { ...offer, state: "active", activeSnapshotId: snapshotId };
        return offer;
      }),
    },
    audit: { record: vi.fn(async () => "a") },
    content: {
      findContentItemForWorkspace: async ({ contentItemId }: { contentItemId: string }) =>
        items.get(contentItemId) ?? null,
      createContentItem: vi.fn(async (item: ContentItem) => (items.set(item.id, item), item)),
    },
    candidates: { findByOffer: async () => cand, transition },
    assets: {
      listByMetadata: async () => (over.pictures ?? ["pic-1"]).map((id) => ({ id })),
    },
    jobs: { enqueue },
    catalogForWorkspace: () => ({ readProductEvidence, ...over.catalog }) as MarketplaceCatalog,
    now: () => now,
  } as unknown as OfferPackageDeps;
  return { deps, items, transition, enqueue, readProductEvidence, getOffer: () => offer };
};

describe("uuidFromKey", () => {
  it("is deterministic and a valid RFC 4122 uuid", () => {
    expect(uuidFromKey("a")).toBe(uuidFromKey("a"));
    expect(uuidFromKey("a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("produceOfferPackage", () => {
  it("creates one item, enqueues copy once, moves the candidate once; rerun adds nothing", async () => {
    const { deps, items, enqueue, transition } = setup();
    const first = await produceOfferPackage(deps, { workspaceId, offerId });
    const second = await produceOfferPackage(deps, { workspaceId, offerId });
    expect(first).toEqual({ contentItemId: uuidFromKey(`auto-sale:${offerId}`), created: true });
    expect(second.created).toBe(false);
    expect(items.size).toBe(1);
    const item = [...items.values()][0];
    expect(item).toMatchObject({
      title: "Auto · Venda · Produto",
      sourceFactKeys: ["current_price", "seller"],
      sourcePictureAssetIds: ["pic-1"],
      creativeOpinion: "good rating",
      state: "draft",
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "draft_offer_copy",
        idempotencyKey: `offer-copy:${item?.id}`,
      }),
    );
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ from: ["linked"], to: "in_production" }),
    );
  });

  it("does not transition a candidate already in production", async () => {
    const { deps, transition } = setup({ candidate: candidate("in_production") });
    await produceOfferPackage(deps, { workspaceId, offerId });
    expect(transition).not.toHaveBeenCalled();
  });

  it("refreshes stale evidence, then packages on the new snapshot", async () => {
    const stale = baseOffer({
      snapshots: [
        {
          id: "s1",
          verifiedAt: new Date(now.getTime() - 3 * 86_400_000),
          facts: [fact("current_price", { amountMinor: 1000, currency: "BRL" })],
        },
      ],
    } as Partial<Offer>);
    const { deps, readProductEvidence, items, getOffer } = setup({ offer: stale });
    await produceOfferPackage(deps, { workspaceId, offerId });
    expect(readProductEvidence).toHaveBeenCalledOnce();
    expect(getOffer()?.activeSnapshotId).toMatch(/^refresh-/);
    expect([...items.values()][0]?.offerSnapshotId).toBe(getOffer()?.activeSnapshotId);
  });

  it("does not read the marketplace for fresh evidence", async () => {
    const { deps, readProductEvidence } = setup();
    await produceOfferPackage(deps, { workspaceId, offerId });
    expect(readProductEvidence).not.toHaveBeenCalled();
  });

  it("retries in 30 minutes when the refresh fails", async () => {
    const { deps } = setup({
      offer: baseOffer({ state: "draft" }),
      catalog: {
        readProductEvidence: async () => {
          throw new Error("boom");
        },
      },
    });
    const error = await produceOfferPackage(deps, { workspaceId, offerId }).catch((e) => e);
    expect(error).toBeInstanceOf(RetryLaterJobError);
    expect((error as RetryLaterJobError).retryAt.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it.each([
    ["archived offer", { offer: baseOffer({ state: "archived" }) }],
    ["rejected offer", { offer: baseOffer({ state: "rejected" }) }],
    ["missing offer", { offer: null }],
    ["missing candidate", { candidate: null }],
    ["consumed candidate", { candidate: candidate("consumed") }],
    ["no listing pictures", { pictures: [] }],
  ])("fails permanently: %s", async (_name, over) => {
    const { deps, items } = setup(over);
    await expect(produceOfferPackage(deps, { workspaceId, offerId })).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    expect(items.size).toBe(0);
  });
});
