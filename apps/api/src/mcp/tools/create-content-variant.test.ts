import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { McpDependencies } from "../server.js";
import { createContentVariantTool } from "./create-content-variant.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://mercadolivre.example/item/1",
  affiliateUrl: "https://meli.la/abc",
  title: "Example product",
  state: "active",
  snapshots: [
    {
      id: "snapshot-1",
      verifiedAt: new Date("2026-09-21T12:00:00.000Z"),
      facts: [
        {
          key: "seller",
          value: "Example seller",
          sourceUrl: "https://mercadolivre.example/item/1",
          verified: true,
        },
      ],
    },
  ],
  activeSnapshotId: "snapshot-1",
};
const item: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: "niche-1",
  offerId: offer.id,
  offerSnapshotId: "snapshot-1",
  title: "Content item",
  sourceFactKeys: ["seller"],
  creativeOpinion: "A practical angle.",
  state: "draft",
};
const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel",
  label: "Instagram",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
  },
};
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://workspace/connection-1",
  accountId: "account-1",
  status: "active",
};
const asset: Asset = {
  id: "asset-1",
  workspaceId,
  objectKey: `workspaces/${workspaceId}/assets/asset-1`,
  checksum: "checksum-1",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  provenance: "operator_upload",
  commercialUse: null,
  license: "operator-owned",
  state: "active",
};

const dependencies = (
  created: ContentVariant[],
  offerValue: Offer = offer,
  existing: ContentVariant[] = [],
): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({
      workspaceId,
      userId: actorId,
      role: "operator",
      status: "active",
    }),
    addMembership: async () => undefined,
  },
  contentRepository: {
    listContentItemsWithoutActiveVariants: async () => [],
    updateContentItemState: async () => null,
    listVariantsForWorkspace: async () => existing,
    createContentItem: async (value) => value,
    findContentItemForWorkspace: async () => item,
    createVariant: async (value) => {
      created.push(value);
      return value;
    },
    findVariantForWorkspace: async () => null,
    findReviewableForWorkspace: async () => [],
    updateVariant: async (value) => value,
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant }) => variant,
  },
  offerRepository: {
    create: async (value) => value,
    findForWorkspace: async () => offerValue,
    addSnapshot: async () => null,
    activate: async () => null,
    reject: async () => null,
  },
  channelRepository: {
    create: async (value) => value,
    findForWorkspace: async () => channel,
    updateStatus: async () => null,
  },
  assetRepository: {
    create: async (value) => value,
    findByMetadata: async () => null,
    findForWorkspace: async () => asset,
    updateState: async () => null,
    completeRenderedAsset: async () => null,
  },
  providerConnections: {
    create: async (value) => ({ ok: true as const, connection: value }),
    findAllForWorkspace: async () => [connection],
    findForWorkspace: async () => connection,
    revoke: async () => undefined,
  },
});

describe("create_content_variant MCP tool", () => {
  it("creates a validated draft using only the authenticated workspace", async () => {
    const created: ContentVariant[] = [];
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "A practical product idea.",
        language: "pt-BR",
      },
      actorId,
      dependencies(created),
    );

    expect(result).toMatchObject({ ok: true, value: { variant: { workspaceId, state: "draft" } } });
    expect(created).toHaveLength(1);
  });
  it("adds the caption to the pending creative variant instead of creating a duplicate", async () => {
    const created: ContentVariant[] = [];
    const pending: ContentVariant = {
      id: "creative-variant-1",
      workspaceId,
      contentItemId: item.id,
      channelId: channel.id,
      offerSnapshotId: item.offerSnapshotId,
      assetIds: [],
      caption: "Caption pending.",
      language: "pt-BR",
      state: "draft",
      voiceScript: [],
      creativeRender: {
        state: "pending",
        templateVersions: {},
        rendererVersion: 1,
        brandKitHash: "",
      },
    };
    const base = dependencies(created, offer, [pending]);
    const updateVariant = vi.fn(async (value: ContentVariant) => value);
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [],
        caption: "A practical product idea.",
        language: "pt-BR",
      },
      actorId,
      {
        ...base,
        contentRepository: {
          ...(base.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
          updateVariant,
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { variant: { id: pending.id, caption: "A practical product idea." } },
    });
    expect(updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.id, creativeRender: pending.creativeRender }),
    );
    expect(created).toHaveLength(0);
  });
  describe("experiment arms", () => {
    const features = (arm: string) => ({
      hookMove: "contrast" as const,
      angle: "a",
      proofType: "none" as const,
      urgency: "none" as const,
      priceShown: false,
      discountShown: false,
      ratingShown: false,
      experiment: { key: "exp-1", arm, feature: "hookMove" as const },
    });
    const sibling = (language: string): ContentVariant => ({
      id: "sibling-1",
      workspaceId,
      contentItemId: "content-0",
      channelId: channel.id,
      offerSnapshotId: "snapshot-1",
      assetIds: [asset.id],
      caption: "x",
      language,
      state: "draft",
      voiceScript: [],
      creativeFeatures: features("a"),
    });
    const run = async (language: string, siblingItem: ContentItem) => {
      const created: ContentVariant[] = [];
      const base = dependencies(created, offer, [sibling(language)]);
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
          creativeFeatures: features("b"),
        },
        actorId,
        {
          ...base,
          contentRepository: {
            ...(base.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
            findContentItemForWorkspace: async ({ contentItemId }) =>
              contentItemId === item.id ? item : siblingItem,
          },
        },
      );
      return { result, created };
    };
    it("accepts a second arm on the same offer, channel kind and language and fills format", async () => {
      const { result, created } = await run("pt-BR", { ...item, id: "content-0" });
      expect(result).toMatchObject({ ok: true });
      expect(created[0]?.creativeFeatures).toMatchObject({
        format: "carousel",
        experiment: { key: "exp-1", arm: "b" },
      });
    });
    it("ignores same-key arms on a different channel kind", async () => {
      const created: ContentVariant[] = [];
      const base = dependencies(created, offer, [
        { ...sibling("pt-BR"), channelId: "other-channel" },
      ]);
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
          creativeFeatures: features("b"),
        },
        actorId,
        {
          ...base,
          channelRepository: {
            ...(base.channelRepository as NonNullable<McpDependencies["channelRepository"]>),
            findForWorkspace: async ({ channelId }) =>
              channelId === channel.id ? channel : { ...channel, id: channelId, kind: "threads" },
          },
          contentRepository: {
            ...(base.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
            findContentItemForWorkspace: async ({ contentItemId }) =>
              contentItemId === item.id ? item : { ...item, id: "content-0", offerId: "offer-2" },
          },
        },
      );
      expect(result).toMatchObject({ ok: true });
    });
    it("rejects an arm on a different offer", async () => {
      const { result } = await run("pt-BR", { ...item, id: "content-0", offerId: "offer-2" });
      expect(result).toEqual({ ok: false, error: "EXPERIMENT_ARM_MISMATCH" });
    });
    it("rejects an arm in a different language", async () => {
      const { result } = await run("en-US", { ...item, id: "content-0" });
      expect(result).toEqual({ ok: false, error: "EXPERIMENT_ARM_MISMATCH" });
    });
  });
  describe("after the offer refresh activates a new snapshot", () => {
    const refreshedOffer = (seller: string): Offer => ({
      ...offer,
      snapshots: [
        ...offer.snapshots,
        {
          id: "snapshot-2",
          verifiedAt: new Date("2026-09-21T18:00:00.000Z"),
          facts: [
            {
              key: "seller",
              value: seller,
              sourceUrl: "https://mercadolivre.example/item/1",
              verified: true,
            },
          ],
        },
      ],
      activeSnapshotId: "snapshot-2",
    });
    const run = (current: Offer, offerSnapshotId: string, created: ContentVariant[]) => {
      const base = dependencies(created);
      return createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
        },
        actorId,
        {
          ...base,
          offerRepository: {
            ...(base.offerRepository as NonNullable<McpDependencies["offerRepository"]>),
            findForWorkspace: async () => current,
          },
        },
      );
    };

    it("accepts the item's or the active snapshot id while cited facts are unchanged", async () => {
      for (const snapshotId of ["snapshot-1", "snapshot-2"]) {
        const created: ContentVariant[] = [];
        const result = await run(refreshedOffer("Example seller"), snapshotId, created);

        expect(result).toMatchObject({ ok: true });
        expect(created[0]?.offerSnapshotId).toBe("snapshot-1");
      }
    });

    it("refuses with OFFER_FACTS_CHANGED when a cited fact changed", async () => {
      const created: ContentVariant[] = [];
      const result = await run(refreshedOffer("Another seller"), "snapshot-2", created);

      expect(result).toEqual({ ok: false, error: "OFFER_FACTS_CHANGED" });
      expect(created).toHaveLength(0);
    });
  });

  it("uses the official affiliate URL when click tracking is unavailable", async () => {
    const created: ContentVariant[] = [];
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "#publi Toque no link\n{link}",
        language: "pt-BR",
      },
      actorId,
      dependencies(created),
    );
    expect(result).toMatchObject({ ok: true });
    expect(created[0]?.caption).toBe(`#publi Toque no link\nhttps://meli.la/abc`);
  });
  it("uses a tracked redirect and records an existing marketplace label", async () => {
    const created: ContentVariant[] = [];
    const createRedirect = vi.fn(
      async (
        record: Parameters<
          NonNullable<McpDependencies["attributionRepository"]>["createRedirect"]
        >[0],
      ) => record,
    );
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "#publi Toque no link\n{link}",
        language: "pt-BR",
        marketplaceLabel: "instagram_casa",
      },
      actorId,
      {
        ...dependencies(created),
        publicApiUrl: "https://mcp.example",
        attributionRepository: {
          createRedirect,
        } as unknown as NonNullable<McpDependencies["attributionRepository"]>,
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(createRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        destination: "https://meli.la/abc",
        contentVariantId: expect.any(String),
        offerId: offer.id,
        marketplaceLabel: "instagram_casa",
      }),
    );
    expect(result).toMatchObject({
      value: {
        variant: {
          caption: expect.stringMatching(
            /^#publi Toque no link\nhttps:\/\/mcp\.example\/go\/[A-Za-z0-9_-]+$/,
          ),
        },
      },
    });
  });
  it("refuses an offer whose affiliate URL is not a Mercado Livre host", async () => {
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "Caption",
        language: "pt-BR",
      },
      actorId,
      dependencies([], { ...offer, affiliateUrl: "https://bit.ly/x" }),
    );
    expect(result).toEqual({ ok: false, error: "AFFILIATE_URL_INVALID" });
  });
  it("stores the creative choices of the post", async () => {
    const created: ContentVariant[] = [];
    const creativeFeatures = {
      hookMove: "proof_first" as const,
      angle: "altura da tela",
      proofType: "rating" as const,
      urgency: "durable" as const,
      priceShown: true,
      discountShown: false,
      ratingShown: true,
    };
    await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "#publi x",
        language: "pt-BR",
        creativeFeatures,
      },
      actorId,
      dependencies(created),
    );
    expect(created[0]?.creativeFeatures).toEqual({ ...creativeFeatures, format: "carousel" });
  });
  it("fills a {link} caption without requiring click tracking", async () => {
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "Toque no link {link}",
        language: "pt-BR",
      },
      actorId,
      dependencies([]),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { variant: { caption: "Toque no link https://meli.la/abc" } },
    });
  });
  it("stores the Canva design reference", async () => {
    const created: ContentVariant[] = [];
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "Caption",
        language: "pt-BR",
        design: { canvaDesignId: "DAF123", pages: [1], width: 1080, height: 1350 },
      },
      actorId,
      dependencies(created),
    );
    expect(result.ok).toBe(true);
    expect(created[0]?.design?.canvaDesignId).toBe("DAF123");
  });

  it("rejects a design whose page count differs from the assets", async () => {
    const created: ContentVariant[] = [];
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "Caption",
        language: "pt-BR",
        design: { canvaDesignId: "DAF123", pages: [1, 2], width: 1080, height: 1350 },
      },
      actorId,
      dependencies(created),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(created).toHaveLength(0);
  });
  describe("instagram_reels", () => {
    const reelsChannel: Channel = {
      ...channel,
      kind: "instagram_reels",
      label: "Reels",
      capabilities: {
        maxAssets: 1,
        requiresOrderedAssets: false,
        allowedMimeTypes: ["video/mp4"],
        captionMaxLength: 2200,
        requiredAssetDimensions: { width: 1080, height: 1920 },
      },
    };
    const video: Asset = {
      ...asset,
      id: "video-1",
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
    };
    const reelDeps = (created: ContentVariant[], sourceContentItemId: string): McpDependencies => {
      const deps = dependencies(created);
      return {
        ...deps,
        channelRepository: {
          create: async (value) => value,
          findForWorkspace: async () => reelsChannel,
          updateStatus: async () => null,
        },
        assetRepository: {
          create: async (value) => value,
          findByMetadata: async () => null,
          findForWorkspace: async () => video,
          updateState: async () => null,
          completeRenderedAsset: async () => null,
        },
        contentRepository: {
          ...(deps.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
          findVariantForWorkspace: async ({ variantId }) =>
            variantId === "carousel-1"
              ? ({ id: "carousel-1", contentItemId: sourceContentItemId } as ContentVariant)
              : null,
        },
        reelRenders: {
          findByAssetForWorkspace: async ({ assetId }: { assetId: string }) =>
            assetId === video.id
              ? { sourceVariantId: "carousel-1", status: "ready", assetId }
              : null,
        } as unknown as NonNullable<McpDependencies["reelRenders"]>,
      };
    };
    const reelInput = {
      workspaceId,
      contentItemId: item.id,
      channelId: reelsChannel.id,
      offerSnapshotId: item.offerSnapshotId,
      assetIds: [video.id],
      caption: "#publi x",
      language: "pt-BR",
    };

    it("accepts the video rendered from this post's own carousel", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(reelInput, actorId, reelDeps(created, item.id));
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    });
    it("accepts a ready vertical owned clip bound to this derivative item", async () => {
      const created: ContentVariant[] = [];
      const deps = reelDeps(created, "unrelated-master");
      const child = { ...item, offerId: null, offerSnapshotId: null, sourceFactKeys: [] };
      const ownedClip = {
        ...video,
        metadata: {
          role: "owned_clip",
          renderStatus: "ready",
          layout: "vertical",
          derivedContentItemId: child.id,
        },
      };
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: child.id,
          channelId: reelsChannel.id,
          assetIds: [video.id],
          caption: "A useful insight.",
          language: "pt-BR",
        },
        actorId,
        {
          ...deps,
          contentRepository: {
            ...(deps.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
            findContentItemForWorkspace: async () => child,
          },
          assetRepository: {
            ...(deps.assetRepository as NonNullable<McpDependencies["assetRepository"]>),
            findForWorkspace: async () => ownedClip,
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    });
    it("refuses a video rendered from another post's carousel", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        reelInput,
        actorId,
        reelDeps(created, "other-content"),
      );
      expect(result).toEqual({ ok: false, error: "REEL_SOURCE_MISMATCH" });
      expect(created).toHaveLength(0);
    });
    it("refuses a video that no reel render produced", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        { ...reelInput, assetIds: ["unknown-video"] },
        actorId,
        reelDeps(created, item.id),
      );
      expect(result).toEqual({ ok: false, error: "REEL_SOURCE_MISMATCH" });
    });
  });
  describe("tiktok_video", () => {
    const tiktokChannel: Channel = {
      ...channel,
      kind: "tiktok_video",
      label: "TikTok",
      capabilities: {
        maxAssets: 1,
        requiresOrderedAssets: false,
        allowedMimeTypes: ["video/mp4"],
        captionMaxLength: 2200,
        requiredAssetDimensions: { width: 1080, height: 1920 },
      },
    };
    const tiktokShopOffer: Offer = {
      id: "offer-tt-1",
      workspaceId,
      marketplace: "tiktok_shop",
      listingUrl: "https://www.tiktok.com/shop/product/tt-1",
      externalProductId: "tt-1",
      title: "TikTok product",
      state: "active",
      snapshots: [
        {
          id: "snapshot-tt-1",
          verifiedAt: new Date("2026-09-21T12:00:00.000Z"),
          facts: [
            {
              key: "seller",
              value: "Loja X",
              sourceUrl: "https://www.tiktok.com/shop/product/tt-1",
              verified: true,
            },
          ],
        },
      ],
      activeSnapshotId: "snapshot-tt-1",
    };
    const tiktokItem: ContentItem = {
      ...item,
      offerId: tiktokShopOffer.id,
      offerSnapshotId: "snapshot-tt-1",
      sourceFactKeys: ["seller"],
    };
    const video: Asset = {
      ...asset,
      id: "video-1",
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
    };
    const tiktokDeps = (
      created: ContentVariant[],
      sourceContentItemId: string,
    ): McpDependencies => {
      const deps = dependencies(created, tiktokShopOffer);
      return {
        ...deps,
        channelRepository: {
          create: async (value) => value,
          findForWorkspace: async () => tiktokChannel,
          updateStatus: async () => null,
        },
        assetRepository: {
          create: async (value) => value,
          findByMetadata: async () => null,
          findForWorkspace: async () => video,
          updateState: async () => null,
          completeRenderedAsset: async () => null,
        },
        contentRepository: {
          ...(deps.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
          findContentItemForWorkspace: async () => tiktokItem,
          findVariantForWorkspace: async ({ variantId }) =>
            variantId === "carousel-1"
              ? ({ id: "carousel-1", contentItemId: sourceContentItemId } as ContentVariant)
              : null,
        },
        reelRenders: {
          findByAssetForWorkspace: async ({ assetId }: { assetId: string }) =>
            assetId === video.id
              ? { sourceVariantId: "carousel-1", status: "ready", assetId }
              : null,
        } as unknown as NonNullable<McpDependencies["reelRenders"]>,
      };
    };
    const tiktokInput = {
      workspaceId,
      contentItemId: tiktokItem.id,
      channelId: tiktokChannel.id,
      offerSnapshotId: tiktokItem.offerSnapshotId,
      assetIds: [video.id],
      caption: "#publi x",
      language: "pt-BR",
    };

    it("accepts a tiktok_shop offer with no affiliate URL, on the video rendered from this post's own carousel", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        tiktokInput,
        actorId,
        tiktokDeps(created, tiktokItem.id),
      );
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    });

    it("refuses a video rendered from another post's carousel", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        tiktokInput,
        actorId,
        tiktokDeps(created, "other-content"),
      );
      expect(result).toEqual({ ok: false, error: "REEL_SOURCE_MISMATCH" });
    });

    it("refuses a tiktok_shop offer bound to an instagram_carousel channel", async () => {
      const created: ContentVariant[] = [];
      const base = dependencies(created, tiktokShopOffer);
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: tiktokItem.id,
          channelId: channel.id,
          offerSnapshotId: tiktokItem.offerSnapshotId,
          assetIds: [asset.id],
          caption: "Caption",
          language: "pt-BR",
        },
        actorId,
        {
          ...base,
          contentRepository: {
            ...(base.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
            findContentItemForWorkspace: async () => tiktokItem,
          },
        },
      );
      expect(result).toEqual({ ok: false, error: "COMMERCE_DESTINATION_UNSUPPORTED" });
      expect(created).toHaveLength(0);
    });

    const mercadoLivreTikTokDeps = (created: ContentVariant[]): McpDependencies => ({
      ...dependencies(created),
      channelRepository: {
        create: async (value) => value,
        findForWorkspace: async () => tiktokChannel,
        updateStatus: async () => null,
      },
      assetRepository: {
        create: async (value) => value,
        findByMetadata: async () => null,
        findForWorkspace: async () => video,
        updateState: async () => null,
        completeRenderedAsset: async () => null,
      },
      reelRenders: {
        findByAssetForWorkspace: async () => ({
          sourceVariantId: "carousel-1",
          status: "ready",
          assetId: video.id,
        }),
      } as unknown as NonNullable<McpDependencies["reelRenders"]>,
      contentRepository: {
        ...(dependencies(created).contentRepository as NonNullable<
          McpDependencies["contentRepository"]
        >),
        findVariantForWorkspace: async () =>
          ({ id: "carousel-1", contentItemId: item.id }) as ContentVariant,
      },
    });

    const mercadoLivreTikTokInput = (caption: string) => ({
      workspaceId,
      contentItemId: item.id,
      channelId: tiktokChannel.id,
      offerSnapshotId: item.offerSnapshotId,
      assetIds: [video.id],
      caption,
      language: "pt-BR",
    });

    it("accepts a mercado_livre offer on tiktok_video when the caption has no link", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        mercadoLivreTikTokInput("#publi O link está no nosso Instagram (ícone no perfil)."),
        actorId,
        mercadoLivreTikTokDeps(created),
      );
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    });

    it("refuses a link in the caption of a mercado_livre offer on tiktok_video", async () => {
      for (const caption of ["#publi Compre aqui {link}", "#publi https://meli.la/abc"]) {
        const created: ContentVariant[] = [];
        const result = await createContentVariantTool(
          mercadoLivreTikTokInput(caption),
          actorId,
          mercadoLivreTikTokDeps(created),
        );
        expect(result).toEqual({
          ok: false,
          error: "CAPTION_LINK_NOT_ALLOWED",
        });
        expect(created).toHaveLength(0);
      }
    });

    it("accepts editorial (no offer) TikTok growth content", async () => {
      const created: ContentVariant[] = [];
      const editorialItem: ContentItem = {
        ...tiktokItem,
        offerId: null,
        offerSnapshotId: null,
        sourceFactKeys: [],
      };
      const deps = tiktokDeps(created, editorialItem.id);
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: editorialItem.id,
          channelId: tiktokChannel.id,
          assetIds: [video.id],
          caption: "A useful tip.",
          language: "pt-BR",
        },
        actorId,
        {
          ...deps,
          contentRepository: {
            ...(deps.contentRepository as NonNullable<McpDependencies["contentRepository"]>),
            findContentItemForWorkspace: async () => editorialItem,
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    });
  });

  it("rejects design dimensions sync_canva_design would never export", async () => {
    const created: ContentVariant[] = [];
    const result = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: item.offerSnapshotId,
        assetIds: [asset.id],
        caption: "Caption",
        language: "pt-BR",
        design: { canvaDesignId: "DAF123", pages: [1], width: 5000, height: 1350 },
      },
      actorId,
      dependencies(created),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(created).toHaveLength(0);
  });
  describe("voiceScript", () => {
    const twoAssetDependencies = (created: ContentVariant[]): McpDependencies => ({
      ...dependencies(created),
      assetRepository: {
        create: async (value) => value,
        findByMetadata: async () => null,
        findForWorkspace: async ({ assetId }) => ({ ...asset, id: assetId }),
        updateState: async () => null,
        completeRenderedAsset: async () => null,
      },
    });

    it("stores a validated voice script for a carousel variant", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id, "asset-2"],
          caption: "A practical product idea.",
          language: "pt-BR",
          voiceScript: ["Frase um.", "Frase dois."],
        },
        actorId,
        twoAssetDependencies(created),
      );
      expect(result).toMatchObject({ ok: true });
      expect(created[0]?.voiceScript).toEqual(["Frase um.", "Frase dois."]);
    });

    it("refuses a voice script on a non-carousel channel", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
          voiceScript: ["x"],
        },
        actorId,
        {
          ...dependencies(created),
          channelRepository: {
            create: async (value) => value,
            findForWorkspace: async () => ({ ...channel, kind: "threads" as const }),
            updateStatus: async () => null,
          },
        },
      );
      expect(result).toEqual({ ok: false, error: "VOICE_SCRIPT_UNSUPPORTED" });
    });

    it("refuses a voice script whose length differs from the asset count", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id, "asset-2"],
          caption: "A practical product idea.",
          language: "pt-BR",
          voiceScript: ["só uma"],
        },
        actorId,
        twoAssetDependencies(created),
      );
      expect(result).toEqual({ ok: false, error: "VOICE_SCRIPT_LENGTH_MISMATCH" });
    });

    it("refuses an invalid voice script item", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
          voiceScript: ["#promo"],
        },
        actorId,
        dependencies(created),
      );
      expect(result).toEqual({ ok: false, error: "VOICE_SCRIPT_ITEM_INVALID" });
    });

    it("rejects more than 10 voice script items via the schema", async () => {
      const created: ContentVariant[] = [];
      const result = await createContentVariantTool(
        {
          workspaceId,
          contentItemId: item.id,
          channelId: channel.id,
          offerSnapshotId: item.offerSnapshotId,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
          voiceScript: Array.from({ length: 11 }, (_, index) => `Frase ${index}.`),
        },
        actorId,
        dependencies(created),
      );
      expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    });
  });
});
