import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaContentRepository } from "./content-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaContentRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaContentRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaContentRepository(client);
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
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("keeps content items and variants scoped to their workspace", async () => {
    const firstWorkspace = await client.workspace.create({ data: { name: "First workspace" } });
    const secondWorkspace = await client.workspace.create({ data: { name: "Second workspace" } });
    const firstWorkspaceId = parseWorkspaceId(firstWorkspace.id);
    const niche = await client.niche.create({
      data: {
        id: "niche-1",
        workspaceId: firstWorkspace.id,
        name: "Home office",
        audience: "Remote workers",
        problem: "Uncomfortable desks",
        editorialVoice: "Practical",
        languages: ["pt-BR"],
        monetizationHypothesis: "Affiliate product recommendations",
      },
    });
    const offer = await client.offer.create({
      data: {
        id: "offer-1",
        workspaceId: firstWorkspace.id,
        marketplace: "MERCADO_LIVRE",
        listingUrl: "https://mercadolivre.example/item/1",
        title: "Desk accessory",
      },
    });
    const snapshot = await client.commercialSnapshot.create({
      data: {
        id: "snapshot-1",
        offerId: offer.id,
        workspaceId: firstWorkspace.id,
        verifiedAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: firstWorkspace.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "secret://workspace/content-test",
        accountId: "account-1",
      },
    });
    const channel = await client.channel.create({
      data: {
        id: "channel-1",
        workspaceId: firstWorkspace.id,
        connectionId: connection.id,
        kind: "INSTAGRAM_CAROUSEL",
        label: "Instagram",
        capabilities: {
          maxAssets: 10,
          requiresOrderedAssets: true,
          allowedMimeTypes: ["image/jpeg"],
          captionMaxLength: 2200,
        },
      },
    });

    const item: ContentItem = {
      id: "content-1",
      workspaceId: firstWorkspaceId,
      nicheId: niche.id,
      offerId: offer.id,
      offerSnapshotId: snapshot.id,
      title: "Desk accessory angle",
      sourceFactKeys: ["current_price"],
      creativeOpinion: "Lead with the use case.",
      state: "draft",
    };
    const variant: ContentVariant = {
      id: "variant-1",
      workspaceId: firstWorkspaceId,
      contentItemId: item.id,
      channelId: channel.id,
      offerSnapshotId: snapshot.id,
      assetIds: [],
      caption: "A practical desk idea.",
      language: "pt-BR",
      state: "draft",
      voiceScript: [],
    };

    await expect(repository.createContentItem(item)).resolves.toMatchObject({ id: item.id });
    await expect(repository.createVariant(variant)).resolves.toMatchObject({ id: variant.id });
    await expect(
      repository.findContentItemForWorkspace({
        workspaceId: parseWorkspaceId(secondWorkspace.id),
        contentItemId: item.id,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findVariantForWorkspace({
        workspaceId: parseWorkspaceId(secondWorkspace.id),
        variantId: variant.id,
      }),
    ).resolves.toBeNull();

    const designed: ContentVariant = {
      ...variant,
      id: "variant-2",
      design: { canvaDesignId: "DAF123", pages: [1], width: 1080, height: 1350 },
      creativeFeatures: {
        hookMove: "contrast",
        angle: "postura",
        proofType: "rating",
        urgency: "none",
        priceShown: true,
        discountShown: false,
        ratingShown: true,
      },
    };
    await repository.createVariant(designed);
    await expect(
      repository.findVariantForWorkspace({ workspaceId: firstWorkspaceId, variantId: designed.id }),
    ).resolves.toMatchObject({
      design: { canvaDesignId: "DAF123", pages: [1], width: 1080, height: 1350 },
      creativeFeatures: { hookMove: "contrast", angle: "postura", ratingShown: true },
    });
    await repository.createVariant({ ...variant, id: "variant-3", state: "cancelled" });
    const unfinished = await repository.listVariantsForWorkspace(firstWorkspaceId, {
      states: ["draft"],
      limit: 1,
    });
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.state).toBe("draft");
    const all = await repository.listVariantsForWorkspace(firstWorkspaceId);
    expect(all.map((entry) => entry.id).sort()).toEqual(["variant-1", "variant-2", "variant-3"]);
    const orphan: ContentItem = { ...item, id: "content-2", title: "Never built" };
    const onlyCancelled: ContentItem = { ...item, id: "content-3", title: "Only cancelled" };
    await repository.createContentItem(orphan);
    await repository.createContentItem(onlyCancelled);
    await repository.createVariant({
      ...variant,
      id: "variant-4",
      contentItemId: onlyCancelled.id,
      state: "cancelled",
    });
    const withoutVariants =
      await repository.listContentItemsWithoutActiveVariants(firstWorkspaceId);
    expect(withoutVariants.map((entry) => entry.id).sort()).toEqual(["content-2", "content-3"]);
    await expect(
      repository.listContentItemsWithoutActiveVariants(firstWorkspaceId, {
        contentItemIds: [item.id],
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listContentItemsWithoutActiveVariants(parseWorkspaceId(secondWorkspace.id)),
    ).resolves.toEqual([]);
    await expect(
      repository.updateContentItemState({
        workspaceId: parseWorkspaceId(secondWorkspace.id),
        contentItemId: orphan.id,
        state: "cancelled",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.updateContentItemState({
        workspaceId: firstWorkspaceId,
        contentItemId: orphan.id,
        state: "cancelled",
      }),
    ).resolves.toMatchObject({ id: orphan.id, state: "cancelled" });
    const afterCancel = await repository.listContentItemsWithoutActiveVariants(firstWorkspaceId, {
      limit: 10,
    });
    expect(afterCancel.map((entry) => entry.id)).toEqual(["content-3"]);
    const plain = await repository.findVariantForWorkspace({
      workspaceId: firstWorkspaceId,
      variantId: variant.id,
    });
    expect(plain?.design).toBeUndefined();
    expect(plain?.voiceScript).toEqual([]);

    const voiced: ContentVariant = {
      ...variant,
      id: "variant-5",
      voiceScript: ["Frase um.", "Frase dois."],
    };
    await repository.createVariant(voiced);
    await expect(
      repository.findVariantForWorkspace({ workspaceId: firstWorkspaceId, variantId: voiced.id }),
    ).resolves.toMatchObject({ voiceScript: ["Frase um.", "Frase dois."] });

    const rendered = await repository.updateVariant({
      ...voiced,
      assetIds: ["asset-a", "asset-b"],
      caption: "Final caption.",
      voiceScript: ["Frase final."],
      creativeRender: {
        state: "rendered",
        brandKitHash: "hash",
        rendererVersion: 1,
        templateVersions: { hero: 1 },
      },
    });
    expect(rendered.assetIds).toEqual(["asset-a", "asset-b"]);
    expect(rendered.caption).toBe("Final caption.");
    expect(rendered.voiceScript).toEqual(["Frase final."]);
    expect(rendered.creativeRender?.state).toBe("rendered");
  });
});
