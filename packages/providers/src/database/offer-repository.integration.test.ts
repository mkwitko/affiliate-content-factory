import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  addEvidenceSnapshot,
  createOffer,
  type CommercialSnapshot,
} from "@money-maker/core/offers/offer";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaOfferRepository } from "./offer-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const verifiedAt = new Date("2026-09-20T12:00:00.000Z");

integration("PrismaOfferRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaOfferRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaOfferRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.contentVariant.deleteMany();
    await client.contentItem.deleteMany();
    await client.commercialFact.deleteMany();
    await client.commercialSnapshot.deleteMany();
    await client.offer.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const createWorkspace = async (name: string) => {
    const workspace = await client.workspace.create({ data: { name } });
    return parseWorkspaceId(workspace.id);
  };

  const evidence: CommercialSnapshot = {
    id: "snapshot-1",
    verifiedAt,
    facts: [
      // Key order: the repository reads facts ordered by key (no insertion order exists).
      {
        key: "availability",
        value: "in_stock",
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
      {
        key: "current_price",
        value: { amountMinor: 12990, currency: "BRL" },
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
      {
        key: "seller",
        value: "Example seller",
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
    ],
  };

  it("keeps offer reads and mutations scoped to their workspace", async () => {
    const workspaceId = await createWorkspace("First workspace");
    const otherWorkspaceId = await createWorkspace("Second workspace");
    const draft = createOffer({
      id: "offer-1",
      workspaceId,
      marketplace: "mercado_livre",
      listingUrl: "https://mercadolivre.example/item/1",
      affiliateUrl: "https://affiliate.example/item/1",
      title: "Example product",
    });
    const withEvidence = addEvidenceSnapshot(draft, evidence);

    await expect(repository.create(draft)).resolves.toEqual(draft);
    await expect(
      repository.addSnapshot({ workspaceId, offerId: draft.id, snapshot: evidence }),
    ).resolves.toEqual(withEvidence);
    await expect(
      repository.findForWorkspace({ workspaceId: otherWorkspaceId, offerId: draft.id }),
    ).resolves.toBeNull();
    await expect(
      repository.findForWorkspace({ workspaceId, offerId: draft.id }),
    ).resolves.toMatchObject({
      affiliateUrl: "https://affiliate.example/item/1",
      snapshots: [expect.objectContaining({ id: "snapshot-1" })],
    });
  });

  it("round-trips a tiktok_shop offer's externalProductId and finds it by marketplace product", async () => {
    const workspaceId = await createWorkspace("TikTok Shop workspace");
    const offer = createOffer({
      id: "offer-tt-1",
      workspaceId,
      marketplace: "tiktok_shop",
      listingUrl: "https://www.tiktok.com/shop/product/tt-prod-1",
      externalProductId: "tt-prod-1",
      title: "TikTok product",
    });

    await repository.create(offer);

    await expect(
      repository.findForWorkspace({ workspaceId, offerId: offer.id }),
    ).resolves.toMatchObject({ marketplace: "tiktok_shop", externalProductId: "tt-prod-1" });
    await expect(
      repository.findByExternalProductForWorkspace?.({
        workspaceId,
        marketplace: "tiktok_shop",
        externalProductId: "tt-prod-1",
      }),
    ).resolves.toMatchObject({ id: "offer-tt-1" });
    await expect(
      repository.findByExternalProductForWorkspace?.({
        workspaceId,
        marketplace: "tiktok_shop",
        externalProductId: "does-not-exist",
      }),
    ).resolves.toBeNull();
  });

  it("lists ACTIVE offers across every workspace, and only those", async () => {
    const workspaceId = await createWorkspace("First workspace");
    const otherWorkspaceId = await createWorkspace("Second workspace");
    const active = createOffer({
      id: "offer-active",
      workspaceId,
      marketplace: "mercado_livre",
      listingUrl: "https://mercadolivre.example/item/1",
      affiliateUrl: "https://affiliate.example/item/1",
      title: "Active product",
    });
    const otherActive = createOffer({
      id: "offer-active-2",
      workspaceId: otherWorkspaceId,
      marketplace: "mercado_livre",
      listingUrl: "https://mercadolivre.example/item/2",
      affiliateUrl: "https://affiliate.example/item/2",
      title: "Active product 2",
    });
    const draft = createOffer({
      id: "offer-draft",
      workspaceId,
      marketplace: "mercado_livre",
      listingUrl: "https://mercadolivre.example/item/3",
      title: "Draft product",
    });
    await repository.create(active);
    await repository.create(otherActive);
    await repository.create(draft);
    const snapshotFor = (id: string): CommercialSnapshot => ({ ...evidence, id });
    await repository.addSnapshot({
      workspaceId,
      offerId: active.id,
      snapshot: snapshotFor("snapshot-active-1"),
    });
    await repository.addSnapshot({
      workspaceId: otherWorkspaceId,
      offerId: otherActive.id,
      snapshot: snapshotFor("snapshot-active-2"),
    });
    await repository.activate({
      workspaceId,
      offerId: active.id,
      snapshotId: "snapshot-active-1",
    });
    await repository.activate({
      workspaceId: otherWorkspaceId,
      offerId: otherActive.id,
      snapshotId: "snapshot-active-2",
    });

    const activeOffers = await repository.listActive();

    expect(activeOffers.map((offer) => offer.id).sort()).toEqual([
      "offer-active",
      "offer-active-2",
    ]);
    expect(activeOffers.every((offer) => offer.state === "active")).toBe(true);
  });
});
