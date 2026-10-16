import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { PrismaProductPostingHistoryRepository } from "./product-posting-history-repository.js";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("103a8e2a-4427-4e17-86fa-b2be48e73e57");
const connectionId = "effef86c-a1da-49b3-8f22-d465799343a5";

integration("PrismaProductPostingHistoryRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaProductPostingHistoryRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaProductPostingHistoryRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
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
    await client.niche.create({
      data: {
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
    await client.providerConnection.create({
      data: {
        id: connectionId,
        workspaceId,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "ref",
        accountId: "acc",
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    // Leave no PublicationAttempt rows behind: reel-render-repository's suite (and others) never
    // expect to find one when it starts.
    await client.publicationAttempt.deleteMany();
    await client.contentVariant.deleteMany();
    await client.contentItem.deleteMany();
    await client.channel.deleteMany();
    await client.commercialSnapshot.deleteMany();
    await client.offer.deleteMany();
    await client.niche.deleteMany();
    await client.providerConnection.deleteMany();
    await client.workspace.deleteMany();
    await client.$disconnect();
  });

  const seedPublished = async (input: {
    offerId: string;
    productId: string;
    variantId: string;
    publishedAt: Date;
    kind?: "INSTAGRAM_CAROUSEL" | "THREADS";
    nicheId?: string;
  }) => {
    const kind = input.kind ?? "INSTAGRAM_CAROUSEL";
    const ws = workspaceId;
    const nicheId = input.nicheId ?? "n1";
    await client.offer.upsert({
      where: { id: input.offerId },
      update: {},
      create: {
        id: input.offerId,
        workspaceId: ws,
        marketplace: "MERCADO_LIVRE",
        listingUrl: `https://www.mercadolivre.com.br/p/${input.productId}`,
        affiliateUrl: "https://meli.la/abc",
        title: `Title ${input.productId}`,
        state: "ACTIVE",
      },
    });
    const channelId = `ch-${kind}`;
    await client.channel.upsert({
      where: { id: channelId },
      update: {},
      create: {
        id: channelId,
        workspaceId: ws,
        connectionId,
        kind,
        label: kind,
        capabilities: {},
      },
    });
    await client.contentItem.create({
      data: {
        id: `item-${input.variantId}`,
        workspaceId: ws,
        nicheId,
        offerId: input.offerId,
        offerSnapshotId: (
          await client.commercialSnapshot.create({
            data: {
              id: `s-${input.variantId}`,
              offerId: input.offerId,
              workspaceId: ws,
              verifiedAt: new Date(),
            },
          })
        ).id,
        title: "t",
        sourceFactKeys: [],
        creativeOpinion: "c",
      },
    });
    await client.contentVariant.create({
      data: {
        id: input.variantId,
        workspaceId: ws,
        contentItemId: `item-${input.variantId}`,
        channelId,
        offerSnapshotId: `s-${input.variantId}`,
        assetIds: [],
        caption: "c",
        language: "pt-BR",
      },
    });
    await client.publicationAttempt.create({
      data: {
        id: `pa-${input.variantId}`,
        workspaceId: ws,
        contentVariantId: input.variantId,
        channelId,
        connectionId,
        idempotencyKey: `publish:${input.variantId}`,
        requestFingerprint: "f",
        status: "PUBLISHED",
        correlationId: "c",
        publishedAt: input.publishedAt,
      },
    });
  };

  it("groups PUBLISHED attempts per Mercado Livre product id, newest first, with the channel set", async () => {
    await seedPublished({
      offerId: "o1",
      productId: "MLB1",
      variantId: "v-old",
      publishedAt: new Date("2026-09-01T10:00:00Z"),
    });
    await seedPublished({
      offerId: "o1-repost",
      productId: "MLB1",
      variantId: "v-new",
      publishedAt: new Date("2026-09-20T10:00:00Z"),
      kind: "THREADS",
    });
    await seedPublished({
      offerId: "o2",
      productId: "MLB2",
      variantId: "v-other",
      publishedAt: new Date("2026-09-10T10:00:00Z"),
    });

    const history = await repository.productPostingHistory({ workspaceId, nicheId: "n1" });

    expect(history).toEqual([
      {
        productId: "MLB1",
        offerTitle: "Title MLB1",
        lastPublishedAt: new Date("2026-09-20T10:00:00Z"),
        publishedCount: 2,
        channels: expect.arrayContaining(["threads", "instagram_carousel"]),
      },
      {
        productId: "MLB2",
        offerTitle: "Title MLB2",
        lastPublishedAt: new Date("2026-09-10T10:00:00Z"),
        publishedCount: 1,
        channels: ["instagram_carousel"],
      },
    ]);
  });

  it("never leaks another workspace's or another niche's posting history", async () => {
    await seedPublished({
      offerId: "o1",
      productId: "MLB1",
      variantId: "v1",
      publishedAt: new Date("2026-09-20T10:00:00Z"),
    });
    await client.niche.create({
      data: {
        id: "n2",
        workspaceId,
        name: "Other niche",
        audience: "a",
        problem: "p",
        editorialVoice: "v",
        languages: ["pt-BR"],
        monetizationHypothesis: "m",
        slug: "other-ab12",
      },
    });
    await expect(repository.productPostingHistory({ workspaceId, nicheId: "n2" })).resolves.toEqual(
      [],
    );

    await expect(
      repository.productPostingHistory({ workspaceId: otherWorkspaceId, nicheId: "n1" }),
    ).resolves.toEqual([]);
  });
});
