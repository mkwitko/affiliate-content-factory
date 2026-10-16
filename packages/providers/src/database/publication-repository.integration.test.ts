import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { CreatePublicationAttemptInput } from "@money-maker/core/publishing/publication";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaPublicationAttemptRepository } from "./publication-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaPublicationAttemptRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaPublicationAttemptRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaPublicationAttemptRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.contentVariant.deleteMany();
    await client.contentItem.deleteMany();
    await client.channel.deleteMany();
    await client.commercialSnapshot.deleteMany();
    await client.offer.deleteMany();
    await client.niche.deleteMany();
    await client.providerConnection.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const fixture = async (label: string) => {
    const workspace = await client.workspace.create({ data: { name: `Publication ${label}` } });
    const niche = await client.niche.create({
      data: {
        id: `niche-${label}`,
        workspaceId: workspace.id,
        name: "Home office",
        audience: "Remote workers",
        problem: "Uncomfortable desks",
        editorialVoice: "Practical",
        languages: ["pt-BR"],
        monetizationHypothesis: "Affiliate recommendations",
      },
    });
    const offer = await client.offer.create({
      data: {
        id: `offer-${label}`,
        workspaceId: workspace.id,
        marketplace: "MERCADO_LIVRE",
        listingUrl: "https://mercadolivre.example/item/1",
        title: "Desk accessory",
      },
    });
    const snapshot = await client.commercialSnapshot.create({
      data: {
        id: `snapshot-${label}`,
        offerId: offer.id,
        workspaceId: workspace.id,
        verifiedAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: workspace.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: `secret://workspace/publication-${label}`,
        accountId: `account-${label}`,
      },
    });
    const channel = await client.channel.create({
      data: {
        id: `channel-${label}`,
        workspaceId: workspace.id,
        connectionId: connection.id,
        kind: "THREADS",
        label: "Threads",
        capabilities: {
          maxAssets: 1,
          requiresOrderedAssets: false,
          allowedMimeTypes: [],
          captionMaxLength: 500,
        },
      },
    });
    const item = await client.contentItem.create({
      data: {
        id: `content-${label}`,
        workspaceId: workspace.id,
        nicheId: niche.id,
        offerId: offer.id,
        offerSnapshotId: snapshot.id,
        title: "Desk angle",
        sourceFactKeys: ["current_price"],
        creativeOpinion: "Lead with the use case.",
      },
    });
    const variant = await client.contentVariant.create({
      data: {
        id: `variant-${label}`,
        workspaceId: workspace.id,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: snapshot.id,
        assetIds: [],
        caption: "A practical desk idea.",
        language: "pt-BR",
      },
    });
    return {
      workspaceId: parseWorkspaceId(workspace.id),
      variantId: variant.id,
      channelId: channel.id,
      connectionId: connection.id,
    };
  };

  const input = (
    fixtureData: Awaited<ReturnType<typeof fixture>>,
    label: string,
  ): CreatePublicationAttemptInput => ({
    attemptId: `attempt-${label}`,
    workspaceId: fixtureData.workspaceId,
    contentVariantId: fixtureData.variantId,
    channelId: fixtureData.channelId,
    connectionId: fixtureData.connectionId,
    idempotencyKey: "publication-key-1",
    requestFingerprint: "sha256:request-1",
    correlationId: `correlation-${label}`,
  });

  it("creates one attempt per workspace and idempotency key", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    const firstInput = input(first, "first");

    await expect(repository.createOrFindByIdempotency(firstInput)).resolves.toMatchObject({
      created: true,
      attempt: { attemptId: "attempt-first", status: "queued", attemptCount: 0 },
    });
    await expect(repository.createOrFindByIdempotency(firstInput)).resolves.toMatchObject({
      created: false,
      attempt: { attemptId: "attempt-first" },
    });
    await expect(
      repository.createOrFindByIdempotency({
        ...input(second, "second"),
        idempotencyKey: firstInput.idempotencyKey,
      }),
    ).resolves.toMatchObject({ created: true, attempt: { attemptId: "attempt-second" } });
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId("33333333-3333-4333-8333-333333333333"),
        attemptId: "attempt-first",
      }),
    ).resolves.toBeNull();
  });

  it("returns the newest attempt per variant, breaking createdAt ties by id, per workspace", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    await repository.createOrFindByIdempotency({
      ...input(first, "a-old"),
      idempotencyKey: "key-old",
    });
    await repository.createOrFindByIdempotency({
      ...input(first, "b-new"),
      idempotencyKey: "key-new",
    });
    await repository.createOrFindByIdempotency(input(second, "other"));
    const sameInstant = new Date("2026-09-23T12:00:00.000Z");
    await client.publicationAttempt.updateMany({
      where: { id: { in: ["attempt-a-old", "attempt-b-new"] } },
      data: { createdAt: sameInstant },
    });

    const latest = await repository.listLatestForVariants({
      workspaceId: first.workspaceId,
      variantIds: [first.variantId, second.variantId],
    });
    expect([...latest.keys()]).toEqual([first.variantId]);
    expect(latest.get(first.variantId)?.attemptId).toBe("attempt-b-new");
    await expect(
      repository.listLatestForVariants({ workspaceId: first.workspaceId, variantIds: [] }),
    ).resolves.toEqual(new Map());
  });

  it("records a manual publication as published with no externalId, idempotent per key", async () => {
    const data = await fixture("manual");
    const publishedAt = new Date("2026-09-24T12:00:00.000Z");
    const manualInput = {
      attemptId: "attempt-manual",
      workspaceId: data.workspaceId,
      contentVariantId: data.variantId,
      channelId: data.channelId,
      connectionId: data.connectionId,
      idempotencyKey: `manual:${data.variantId}`,
      requestFingerprint: "sha256:manual",
      correlationId: "correlation-manual",
      publishedAt,
    };

    await expect(repository.createOrFindManualPublication(manualInput)).resolves.toMatchObject({
      created: true,
      attempt: { attemptId: "attempt-manual", status: "published" },
    });
    const stored = await repository.findForWorkspace({
      workspaceId: data.workspaceId,
      attemptId: "attempt-manual",
    });
    expect(stored?.externalId).toBeUndefined();

    await expect(
      repository.createOrFindManualPublication({ ...manualInput, attemptId: "attempt-other" }),
    ).resolves.toMatchObject({ created: false, attempt: { attemptId: "attempt-manual" } });
  });
});
