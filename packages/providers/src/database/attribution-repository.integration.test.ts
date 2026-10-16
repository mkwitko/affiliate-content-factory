import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createRedirect } from "@money-maker/core/analytics/attribution";
import { PrismaAttributionRepository } from "./attribution-repository.js";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("103a8e2a-4427-4e17-86fa-b2be48e73e57");

integration("PrismaAttributionRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaAttributionRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaAttributionRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.clickEvent.deleteMany();
    await client.trackedLink.deleteMany();
    await client.publicationAttempt.deleteMany();
    await client.contentVariant.deleteMany();
    await client.contentItem.deleteMany();
    await client.channel.deleteMany();
    await client.commercialFact.deleteMany();
    await client.commercialSnapshot.deleteMany();
    await client.offer.deleteMany();
    await client.niche.deleteMany();
    await client.providerConnection.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
    for (const id of [workspaceId, otherWorkspaceId])
      await client.workspace.create({ data: { id, name: `Workspace ${id}` } });
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const seedPublishedVariant = async (
    variantId: string,
    publishedAt: Date,
    kind: "INSTAGRAM_CAROUSEL" | "THREADS" = "INSTAGRAM_CAROUSEL",
  ) => {
    await client.niche.upsert({
      where: { id: "n1" },
      update: {},
      create: {
        id: "n1",
        workspaceId,
        name: "Tech",
        audience: "a",
        problem: "p",
        editorialVoice: "v",
        languages: ["pt-BR"],
        monetizationHypothesis: "m",
        slug: "tech-ab12",
      },
    });
    await client.offer.upsert({
      where: { id: "o1" },
      update: {},
      create: {
        id: "o1",
        workspaceId,
        marketplace: "MERCADO_LIVRE",
        listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
        affiliateUrl: "https://meli.la/abc",
        title: "Suporte",
        state: "ACTIVE",
      },
    });
    await client.commercialSnapshot.upsert({
      where: { id: "s1" },
      update: {},
      create: { id: "s1", offerId: "o1", workspaceId, verifiedAt: new Date() },
    });
    await client.providerConnection.upsert({
      where: { id: "effef86c-a1da-49b3-8f22-d465799343a5" },
      update: {},
      create: {
        id: "effef86c-a1da-49b3-8f22-d465799343a5",
        workspaceId,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "ref",
        accountId: "acc",
      },
    });
    const channelId = `ch-${kind}`;
    await client.channel.upsert({
      where: { id: channelId },
      update: {},
      create: {
        id: channelId,
        workspaceId,
        connectionId: "effef86c-a1da-49b3-8f22-d465799343a5",
        kind,
        label: kind,
        capabilities: {},
      },
    });
    await client.contentItem.upsert({
      where: { id: "i1" },
      update: {},
      create: {
        id: "i1",
        workspaceId,
        nicheId: "n1",
        offerId: "o1",
        offerSnapshotId: "s1",
        title: "t",
        sourceFactKeys: [],
        creativeOpinion: "c",
      },
    });
    await client.contentVariant.create({
      data: {
        id: variantId,
        workspaceId,
        contentItemId: "i1",
        channelId,
        offerSnapshotId: "s1",
        assetIds: [],
        caption: "c",
        language: "pt-BR",
      },
    });
    await client.publicationAttempt.create({
      data: {
        id: `pa-${variantId}`,
        workspaceId,
        contentVariantId: variantId,
        channelId,
        connectionId: "effef86c-a1da-49b3-8f22-d465799343a5",
        idempotencyKey: `publish:${variantId}`,
        requestFingerprint: "f",
        status: "PUBLISHED",
        correlationId: "c",
        publishedAt,
      },
    });
  };

  it("persists a link, finds it by slug and by variant, never across workspaces", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() + 60_000),
      contentVariantId: "v1",
      publicationAttemptId: "attempt-1",
      marketplaceLabel: "instagram_casa",
      fallback: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    });
    await repository.createRedirect(record);
    await expect(repository.findBySlug(record.slug)).resolves.toEqual(record);
    await expect(
      repository.findForVariant({ workspaceId, contentVariantId: "v1" }),
    ).resolves.toEqual(record);
    await expect(
      repository.findForPublicationAttempt?.({ workspaceId, attemptId: "attempt-1" }),
    ).resolves.toEqual(record);
    await expect(
      repository.findForVariant({ workspaceId: otherWorkspaceId, contentVariantId: "v1" }),
    ).resolves.toBeNull();
    await expect(
      repository.findForPublicationAttempt?.({
        workspaceId: otherWorkspaceId,
        attemptId: "attempt-1",
      }),
    ).resolves.toBeNull();
  });

  it("resolves the niche storefront to every published variant of its active offers", async () => {
    await seedPublishedVariant("v-old", new Date("2026-09-20T10:00:00Z"));
    await seedPublishedVariant("v-new", new Date("2026-09-23T10:00:00Z"));
    await seedPublishedVariant("v-threads", new Date("2026-09-24T10:00:00Z"), "THREADS");
    await expect(repository.findNicheStorefront("tech-ab12")).resolves.toEqual({
      workspaceId,
      nicheName: "Tech",
      candidates: [
        expect.objectContaining({ contentVariantId: "v-threads", offerId: "o1" }),
        expect.objectContaining({ contentVariantId: "v-new", offerId: "o1" }),
        expect.objectContaining({ contentVariantId: "v-old", offerId: "o1" }),
      ],
    });
    await expect(repository.findNicheStorefront("unknown")).resolves.toBeNull();
  });

  it("attaches the verified prices of each offer's active snapshot, never another workspace's", async () => {
    await seedPublishedVariant("v1", new Date("2026-09-23T10:00:00Z"));
    const verifiedAt = new Date("2026-09-24T09:00:00Z");
    await client.commercialSnapshot.create({
      data: { id: "s-active", offerId: "o1", workspaceId, verifiedAt },
    });
    const fact = (key: string, amountMinor: number, verified = true) => ({
      id: `f-${key}`,
      snapshotId: "s-active",
      key,
      value: { amountMinor, currency: "BRL" },
      sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
      verified,
    });
    await client.commercialFact.createMany({
      data: [
        fact("current_price", 12990),
        fact("list_price", 15990, false),
        {
          ...fact("seller", 0),
          value: "Loja",
        },
      ],
    });
    await client.offer.update({ where: { id: "o1" }, data: { activeSnapshotId: "s-active" } });
    const storefront = await repository.findNicheStorefront("tech-ab12");
    expect(storefront?.candidates[0]?.activeSnapshot).toEqual({
      verifiedAt,
      currentPrice: { amountMinor: 12990, currency: "BRL" },
    });
    await client.commercialSnapshot.update({
      where: { id: "s-active" },
      data: { workspaceId: otherWorkspaceId },
    });
    const crossTenant = await repository.findNicheStorefront("tech-ab12");
    expect(crossTenant?.candidates[0]).not.toHaveProperty("activeSnapshot");
  });

  it("marks the active snapshot unavailable when a refresh recorded the listing as delisted", async () => {
    await seedPublishedVariant("v1", new Date("2026-09-23T10:00:00Z"));
    const verifiedAt = new Date("2026-09-24T09:00:00Z");
    await client.commercialSnapshot.create({
      data: { id: "s-refresh", offerId: "o1", workspaceId, verifiedAt },
    });
    await client.commercialFact.create({
      data: {
        id: "f-availability",
        snapshotId: "s-refresh",
        key: "availability",
        value: false,
        sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
        verified: true,
      },
    });
    await client.offer.update({ where: { id: "o1" }, data: { activeSnapshotId: "s-refresh" } });

    const storefront = await repository.findNicheStorefront("tech-ab12");

    expect(storefront?.candidates[0]?.activeSnapshot).toEqual({ verifiedAt, available: false });
  });

  it("summarizes clicks and unique visitors per variant and niche, scoped to the workspace", async () => {
    await seedPublishedVariant("v1", new Date());
    for (const visitorHash of ["a", "a", "b"])
      await repository.recordClick({
        workspaceId,
        contentVariantId: "v1",
        via: "direct",
        expired: false,
        visitorHash,
      });
    await repository.recordClick({
      workspaceId: otherWorkspaceId,
      via: "direct",
      expired: false,
      visitorHash: "z",
    });
    await expect(repository.summary(workspaceId, { groupBy: "variant" })).resolves.toEqual([
      { key: "v1", clicks: 3, uniqueClicks: 2, lastClickAt: expect.any(Date) },
    ]);
    await expect(repository.summary(workspaceId, { groupBy: "niche" })).resolves.toEqual([
      expect.objectContaining({ key: "n1", clicks: 3 }),
    ]);
    await repository.recordClick({
      workspaceId,
      contentVariantId: "v1",
      publicationAttemptId: "attempt-1",
      via: "direct",
      expired: false,
      visitorHash: "publication-click",
    });
    await expect(repository.summary(workspaceId, { groupBy: "publication" })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "attempt-1", clicks: 1 }),
        expect.objectContaining({ key: "unattributed", clicks: 3 }),
      ]),
    );
    await expect(
      repository.summary(workspaceId, { groupBy: "variant", since: new Date(Date.now() + 60_000) }),
    ).resolves.toEqual([]);
  });
});
