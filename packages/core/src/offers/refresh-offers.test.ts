import { describe, expect, it } from "vitest";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import type { AuditEvent, AuditPort } from "../audit/audit-port.js";
import {
  activateOffer,
  addEvidenceSnapshot,
  createOffer,
  type CommercialSnapshot,
  type Offer,
} from "./offer.js";
import type { OfferRepository, WorkspaceOfferInput } from "./offer-repository.js";
import type { MarketplaceCatalog, ProductEvidence } from "./marketplace-catalog.js";
import { refreshActiveOffers, SYSTEM_OFFER_REFRESH_ACTOR } from "./refresh-offers.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("103a8e2a-4427-4e17-86fa-b2be48e73e57");
const verifiedAt = new Date("2026-09-20T12:00:00.000Z");
const now = new Date("2026-09-21T12:00:00.000Z");
const listingUrl = "https://www.mercadolivre.com.br/p/MLB777";

const baseSnapshot = (overrides: Partial<CommercialSnapshot> = {}): CommercialSnapshot => ({
  id: "snapshot-1",
  verifiedAt,
  facts: [
    { key: "seller", value: "Example seller", sourceUrl: listingUrl, verified: true },
    { key: "availability", value: "available", sourceUrl: listingUrl, verified: true },
    {
      key: "current_price",
      value: { amountMinor: 12990, currency: "BRL" },
      sourceUrl: listingUrl,
      verified: true,
    },
  ],
  ...overrides,
});

const buildActiveOffer = (input: {
  id: string;
  workspaceId: WorkspaceId;
  title?: string;
}): Offer => {
  const draft = createOffer({
    id: input.id,
    workspaceId: input.workspaceId,
    marketplace: "mercado_livre",
    listingUrl,
    affiliateUrl: "https://meli.la/abc",
    title: input.title ?? "Example product",
  });
  return activateOffer(addEvidenceSnapshot(draft, baseSnapshot()), now);
};

const evidence = (overrides: Partial<ProductEvidence> = {}): ProductEvidence => ({
  providerId: "MLB777",
  title: "Example product",
  listingUrl: new URL(listingUrl),
  seller: "Example seller",
  availability: "available",
  currentPrice: { amountMinor: 12990, currency: "BRL" },
  observedAt: new Date("2026-09-25T10:00:00.000Z"),
  ...overrides,
  listingStatus: overrides.listingStatus ?? "active",
});

type FakeOfferRepository = OfferRepository &
  Readonly<{
    listActive: NonNullable<OfferRepository["listActive"]>;
    get: (offerId: string) => Offer | undefined;
  }>;

const createFakeOfferRepository = (offers: readonly Offer[]): FakeOfferRepository => {
  const store = new Map(offers.map((offer) => [offer.id, offer]));
  return {
    create: async (offer) => offer,
    listActive: async () => [...store.values()].filter((offer) => offer.state === "active"),
    findForWorkspace: async ({ workspaceId: scope, offerId }: WorkspaceOfferInput) => {
      const offer = store.get(offerId);
      return offer && offer.workspaceId === scope ? offer : null;
    },
    addSnapshot: async ({
      workspaceId: scope,
      offerId,
      snapshot,
    }: WorkspaceOfferInput & { snapshot: CommercialSnapshot }) => {
      const offer = store.get(offerId);
      if (!offer || offer.workspaceId !== scope) return null;
      const updated = { ...offer, snapshots: [...offer.snapshots, snapshot] };
      store.set(offerId, updated);
      return updated;
    },
    activate: async ({
      workspaceId: scope,
      offerId,
      snapshotId,
    }: WorkspaceOfferInput & { snapshotId: string }) => {
      const offer = store.get(offerId);
      if (!offer || offer.workspaceId !== scope) return null;
      const updated = { ...offer, activeSnapshotId: snapshotId };
      store.set(offerId, updated);
      return updated;
    },
    reject: async () => null,
    get: (offerId) => store.get(offerId),
  };
};

const createRecordingAudit = (): AuditPort & { events: AuditEvent[] } => {
  const events: AuditEvent[] = [];
  return {
    events,
    record: async (event) => {
      events.push(event);
      return `audit-${events.length}`;
    },
  };
};

describe("refreshActiveOffers", () => {
  it("creates a new active snapshot when the price changed", async () => {
    const offer = buildActiveOffer({ id: "o1", workspaceId });
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: () =>
        ({
          readProductEvidence: async () =>
            evidence({ currentPrice: { amountMinor: 13990, currency: "BRL" } }),
        }) as unknown as MarketplaceCatalog,
    });

    const updated = repository.get("o1");
    expect(updated?.snapshots).toHaveLength(2);
    expect(updated?.activeSnapshotId).toBe(updated?.snapshots.at(-1)?.id);
    const priceFact = updated?.snapshots.at(-1)?.facts.find((fact) => fact.key === "current_price");
    expect(priceFact?.value).toEqual({ amountMinor: 13990, currency: "BRL" });
  });

  it("still writes a new snapshot with a fresh verifiedAt when nothing changed", async () => {
    const offer = buildActiveOffer({ id: "o1", workspaceId });
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: () =>
        ({
          readProductEvidence: async () => evidence(),
        }) as unknown as MarketplaceCatalog,
    });

    const updated = repository.get("o1");
    expect(updated?.snapshots).toHaveLength(2);
    expect(updated?.snapshots.at(-1)?.verifiedAt).toEqual(evidence().observedAt);
    expect(updated?.snapshots.at(-1)?.id).not.toBe(offer.snapshots[0]?.id);
  });

  it("skips a tiktok_shop offer instead of calling a marketplace catalog for it", async () => {
    const draft = createOffer({
      id: "o1",
      workspaceId,
      marketplace: "tiktok_shop",
      listingUrl: "https://www.tiktok.com/shop/product/tt-1",
      externalProductId: "tt-1",
      title: "TikTok product",
    });
    const offer = activateOffer(
      addEvidenceSnapshot(draft, {
        id: "snapshot-1",
        verifiedAt,
        facts: [
          {
            key: "seller",
            value: "Loja X",
            sourceUrl: "https://www.tiktok.com/shop/product/tt-1",
            verified: true,
          },
          {
            key: "current_price",
            value: { amountMinor: 4990, currency: "BRL" },
            sourceUrl: "https://www.tiktok.com/shop/product/tt-1",
            verified: true,
          },
          {
            key: "commission_percent",
            value: 15,
            sourceUrl: "https://www.tiktok.com/shop/product/tt-1",
            verified: true,
          },
        ],
      }),
      now,
    );
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();
    const skipped: unknown[] = [];
    let catalogRequested = false;

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: () => {
        catalogRequested = true;
        return { readProductEvidence: async () => evidence() } as unknown as MarketplaceCatalog;
      },
      onSkipped: (input) => skipped.push(input),
    });

    expect(catalogRequested).toBe(false);
    expect(repository.get("o1")).toEqual(offer);
    expect(skipped).toEqual([{ offerId: "o1", workspaceId, reason: "marketplace_unsupported" }]);
  });

  it("skips an offer whose identity changed instead of writing a conflicting snapshot", async () => {
    const offer = buildActiveOffer({ id: "o1", workspaceId });
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();
    const skipped: unknown[] = [];

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: () =>
        ({
          readProductEvidence: async () => evidence({ title: "A completely different product" }),
        }) as unknown as MarketplaceCatalog,
      onSkipped: (input) => skipped.push(input),
    });

    expect(repository.get("o1")).toEqual(offer);
    expect(skipped).toEqual([{ offerId: "o1", workspaceId, reason: "identity_conflict" }]);
    expect(audit.events).toHaveLength(0);
  });

  it("records availability false without changing offer state when the listing is delisted", async () => {
    const offer = buildActiveOffer({ id: "o1", workspaceId });
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();

    await refreshActiveOffers({
      offers: repository,
      audit,
      now: () => new Date("2026-09-25T10:00:00.000Z"),
      marketplaceCatalogForWorkspace: () =>
        ({
          readProductEvidence: async () => {
            throw new Error("listing_unavailable");
          },
        }) as unknown as MarketplaceCatalog,
    });

    const updated = repository.get("o1");
    expect(updated?.state).toBe("active");
    expect(updated?.snapshots.at(-1)?.facts).toEqual([
      { key: "availability", value: false, sourceUrl: listingUrl, verified: true },
    ]);
    expect(updated?.activeSnapshotId).toBe(updated?.snapshots.at(-1)?.id);
  });

  it("isolates a provider failure to its own workspace and keeps refreshing the rest", async () => {
    const failing = buildActiveOffer({ id: "o1", workspaceId });
    const healthy = buildActiveOffer({ id: "o2", workspaceId: otherWorkspaceId });
    const repository = createFakeOfferRepository([failing, healthy]);
    const audit = createRecordingAudit();
    const skipped: unknown[] = [];

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: (scope) =>
        ({
          readProductEvidence: async () => {
            if (scope === workspaceId) throw new Error("rate_limited");
            return evidence();
          },
        }) as unknown as MarketplaceCatalog,
      onSkipped: (input) => skipped.push(input),
    });

    expect(repository.get("o1")).toEqual(failing);
    expect(skipped).toEqual([{ offerId: "o1", workspaceId, reason: "rate_limited" }]);
    expect(repository.get("o2")?.snapshots).toHaveLength(2);
  });

  it("records the activation audit entry under the system actor, never a human user", async () => {
    const offer = buildActiveOffer({ id: "o1", workspaceId });
    const repository = createFakeOfferRepository([offer]);
    const audit = createRecordingAudit();

    await refreshActiveOffers({
      offers: repository,
      audit,
      marketplaceCatalogForWorkspace: () =>
        ({
          readProductEvidence: async () => evidence(),
        }) as unknown as MarketplaceCatalog,
    });

    expect(audit.events).toEqual([
      expect.objectContaining({
        action: "offer.activated",
        workspaceId,
        systemActor: SYSTEM_OFFER_REFRESH_ACTOR,
        targetId: "o1",
      }),
    ]);
    expect(audit.events[0]).not.toHaveProperty("actorUserId");
  });
});
