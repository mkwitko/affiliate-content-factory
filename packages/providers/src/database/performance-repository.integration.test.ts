import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaPerformanceRepository } from "./performance-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("103a8e2a-4427-4e17-86fa-b2be48e73e57");
const connectionId = "effef86c-a1da-49b3-8f22-d465799343a5";

integration("PrismaPerformanceRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaPerformanceRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaPerformanceRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.contentPerformance.deleteMany();
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
      },
    });
    await client.offer.create({
      data: {
        id: "o1",
        workspaceId,
        marketplace: "MERCADO_LIVRE",
        listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
        title: "Suporte",
      },
    });
    await client.commercialSnapshot.create({
      data: { id: "s1", offerId: "o1", workspaceId, verifiedAt: new Date() },
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
    await client.channel.create({
      data: {
        id: "ch1",
        workspaceId,
        connectionId,
        kind: "INSTAGRAM_CAROUSEL",
        label: "Feed",
        capabilities: {},
      },
    });
    await client.contentItem.create({
      data: {
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
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const publish = async (variantId: string, status: "PUBLISHED" | "QUEUED", publishedAt: Date) => {
    await client.contentVariant.create({
      data: {
        id: variantId,
        workspaceId,
        contentItemId: "i1",
        channelId: "ch1",
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
        channelId: "ch1",
        connectionId,
        idempotencyKey: `publish:${variantId}`,
        requestFingerprint: "f",
        status,
        correlationId: "c",
        externalId: `sp_${variantId}`,
        publishedAt,
      },
    });
  };

  it("lists published posts with their observation count, and reads the newest metrics per variant", async () => {
    const publishedAt = new Date("2026-09-20T10:00:00Z");
    await publish("v1", "PUBLISHED", publishedAt);
    await publish("v2", "QUEUED", publishedAt);
    await repository.record({
      workspaceId,
      contentVariantId: "v1",
      publicationAttemptId: "pa-v1",
      observedAt: new Date("2026-09-21T10:00:00Z"),
      metrics: { reach: 100, likes: 4 },
    });
    await repository.record({
      workspaceId,
      contentVariantId: "v1",
      publicationAttemptId: "pa-v1",
      observedAt: new Date("2026-09-23T10:00:00Z"),
      metrics: {
        reach: 900,
        likes: 40,
        saves: 12,
        estimatedMinutesWatched: 11,
        averageViewDurationSeconds: 34,
        averageViewPercentage: 47.25,
        subscribersGained: 3,
        subscribersLost: 1,
        engagedViews: 88,
      },
      platformUrl: "https://www.instagram.com/p/abc",
    });
    await expect(repository.listSyncCandidates(new Date("2026-09-01T00:00:00Z"))).resolves.toEqual([
      {
        workspaceId,
        publicationAttemptId: "pa-v1",
        contentVariantId: "v1",
        connectionId,
        externalId: "sp_v1",
        publishedAt,
        observationCount: 2,
      },
    ]);
    // A later empty read (the post left the feed) does not hide the real metrics.
    await repository.record({
      workspaceId,
      contentVariantId: "v1",
      publicationAttemptId: "pa-v1",
      observedAt: new Date("2026-09-27T10:00:00Z"),
      metrics: {},
    });
    // A row claiming another workspace never joins this workspace's attempt.
    await repository.record({
      workspaceId: otherWorkspaceId,
      contentVariantId: "v1",
      publicationAttemptId: "pa-v1",
      observedAt: new Date("2026-09-28T10:00:00Z"),
      metrics: { reach: 1 },
    });
    await expect(repository.latestByVariant(workspaceId)).resolves.toEqual([
      {
        workspaceId,
        contentVariantId: "v1",
        publicationAttemptId: "pa-v1",
        observedAt: new Date("2026-09-23T10:00:00Z"),
        metrics: {
          reach: 900,
          likes: 40,
          saves: 12,
          estimatedMinutesWatched: 11,
          averageViewDurationSeconds: 34,
          averageViewPercentage: 47.25,
          subscribersGained: 3,
          subscribersLost: 1,
          engagedViews: 88,
        },
        platformUrl: "https://www.instagram.com/p/abc",
        channelId: "ch1",
        publishedAt,
        creativeFeatures: null,
      },
    ]);
    await expect(repository.latestByVariant(otherWorkspaceId)).resolves.toEqual([]);
    await expect(
      repository.latestByVariant(workspaceId, { since: new Date("2026-09-21T00:00:00Z") }),
    ).resolves.toEqual([]);
  });

  it("picks the first non-empty observation at or after each checkpoint", async () => {
    const publishedAt = new Date("2026-09-01T10:00:00Z");
    await publish("v1", "PUBLISHED", publishedAt);
    await client.contentVariant.update({
      where: { id: "v1" },
      data: { creativeFeatures: { hookMove: "contrast" } },
    });
    const at = (days: number) => new Date(publishedAt.getTime() + days * 86_400_000 + 60_000);
    const record = (days: number, metrics: { shares?: number }) =>
      repository.record({
        workspaceId,
        contentVariantId: "v1",
        publicationAttemptId: "pa-v1",
        observedAt: at(days),
        metrics,
      });
    await record(1, { shares: 1 });
    await record(3, { shares: 3 });
    await record(7, {});
    await record(8, { shares: 8 });
    await record(30, { shares: 30 });
    await client.clickEvent.create({
      data: { workspaceId, contentVariantId: "v1", via: "t", visitorHash: "h1" },
    });
    const untracked = await repository.observationsAtCheckpoint(workspaceId, { checkpointDays: 7 });
    expect(untracked[0]?.uniqueClicks).toBeNull();
    await client.trackedLink.create({
      data: {
        slug: "v1-link",
        workspaceId,
        contentVariantId: "v1",
        destination: "https://example.test/p",
        destinationFingerprint: "fp",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      },
    });
    const at7 = await repository.observationsAtCheckpoint(workspaceId, { checkpointDays: 7 });
    expect(at7).toHaveLength(1);
    expect(at7[0]).toMatchObject({
      contentVariantId: "v1",
      channelKind: "instagram_carousel",
      metrics: { shares: 8 },
      creativeFeatures: { hookMove: "contrast" },
      uniqueClicks: 1,
    });
    const shares = async (days: 1 | 3 | 7 | 30) =>
      (await repository.observationsAtCheckpoint(workspaceId, { checkpointDays: days }))[0]?.metrics
        .shares;
    expect([await shares(1), await shares(3), await shares(30)]).toEqual([1, 3, 30]);
    await expect(
      repository.observationsAtCheckpoint(otherWorkspaceId, { checkpointDays: 7 }),
    ).resolves.toEqual([]);
  });
});
