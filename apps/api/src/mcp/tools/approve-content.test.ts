import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";
import type { McpDependencies } from "../server.js";
import { approveContentTool } from "./approve-content.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");

const baseVariant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: "channel-1",
  offerSnapshotId: "snapshot-1",
  assetIds: ["asset-1"],
  caption: "A useful idea.",
  language: "pt-BR",
  state: "ready_for_review",
  voiceScript: [],
};
const asset: Asset = {
  id: "asset-1",
  workspaceId,
  objectKey: "workspaces/11111111-1111-4111-8111-111111111111/assets/asset-1",
  checksum: "checksum-1",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  provenance: "operator_upload",
  commercialUse: null,
  license: "operator-owned",
  state: "active",
};
const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "conn-1",
  kind: "instagram_carousel",
  label: "Instagram",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1350 },
  },
};
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://produto.mercadolivre.com.br/1",
  title: "Product",
  state: "active",
  activeSnapshotId: "snapshot-1",
  snapshots: [],
};
const contentItem: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: "niche-1",
  offerId: "offer-1",
  offerSnapshotId: "snapshot-1",
  title: "Post",
  sourceFactKeys: ["price"],
  creativeOpinion: "opinion",
  state: "draft",
};
const connection: ProviderConnection = {
  id: "conn-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  accountId: "account-1",
  secretReference: "secret://workspace/11111111-1111-4111-8111-111111111111/post_for_me",
  status: "active",
};

const fixture = (
  variant: ContentVariant,
  overrides: { asset?: Asset; assets?: Record<string, Asset>; channel?: Channel } = {},
): { dependencies: McpDependencies; recorded: () => ContentVariant | undefined } => {
  let recorded: ContentVariant | undefined;
  const content: ContentRepository = {
    listContentItemsWithoutActiveVariants: async () => [],
    updateContentItemState: async () => null,
    listVariantsForWorkspace: async () => [],
    createContentItem: async (value) => value,
    findContentItemForWorkspace: async () => contentItem,
    createVariant: async (value) => value,
    findVariantForWorkspace: async () => variant,
    findReviewableForWorkspace: async () => [variant],
    updateVariant: async (value) => value,
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant: value }) => {
      recorded = value;
      return value;
    },
  };
  const policies: PublicationPolicyRepository = {
    findForWorkspace: async () => ({ workspaceId, mode: "manual", version: 1 }),
    create: async (value) => value,
    update: async (value) => value,
  };
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "reviewer",
        status: "active",
      }),
      addMembership: async () => undefined,
    },
    contentRepository: content,
    assetRepository: {
      create: async (value) => value,
      findByMetadata: async () => null,
      findForWorkspace: async ({ assetId }: { assetId: string }) =>
        overrides.assets?.[assetId] ?? overrides.asset ?? asset,
      updateState: async () => null,
      completeRenderedAsset: async () => null,
    },
    channelRepository: {
      create: async (value) => value,
      listForWorkspace: async () => [overrides.channel ?? channel],
      findForWorkspace: async () => overrides.channel ?? channel,
      updateStatus: async () => null,
    },
    offerRepository: {
      create: async (value) => value,
      listForWorkspace: async () => [offer],
      findForWorkspace: async () => offer,
      addSnapshot: async () => offer,
      activate: async () => offer,
      reject: async () => offer,
    },
    providerConnections: {
      create: async (value) => ({ ok: true, connection: value }),
      findAllForWorkspace: async () => [connection],
      findForWorkspace: async () => connection,
      revoke: async () => undefined,
    },
    publicationPolicyRepository: policies,
  };
  return { dependencies, recorded: () => recorded };
};

const approve = (dependencies: McpDependencies) =>
  approveContentTool({ workspaceId, variantId: baseVariant.id }, actorId, dependencies);

describe("approve_content generated scene clip rights", () => {
  const reels: Channel = {
    ...channel,
    kind: "tiktok_video",
    capabilities: {
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: ["video/mp4"],
      captionMaxLength: 2200,
      requiredAssetDimensions: { width: 1080, height: 1920 },
    },
  };
  const render: Asset = {
    ...asset,
    id: "render-1",
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    provenance: "rendered",
    license: "Rendered from approved script and storyboard",
    metadata: { role: "long_form_video", sourceAssetIds: ["clip-1", "plate-1"] },
  };
  const clip = (commercialUse: boolean | null): Asset => ({
    ...asset,
    id: "clip-1",
    mimeType: "video/mp4",
    provenance: "generated",
    license: "internal",
    commercialUse,
    metadata: { role: "stage_artifact", stage: "scene_clip" },
  });
  const plate: Asset = {
    ...asset,
    id: "plate-1",
    provenance: "operator_upload",
    commercialUse: true,
  };
  // Disclosed, so these tests reach the G0 rights gate (Agnes ToS 6.1 disclosure comes first).
  const variant: ContentVariant = {
    ...baseVariant,
    assetIds: ["render-1"],
    caption: "A useful idea. Cenas geradas por IA.",
  };
  const run = (commercialUse: boolean | null, caption = variant.caption) => {
    const { dependencies, recorded } = fixture(
      { ...variant, caption },
      {
        channel: reels,
        asset: render,
        assets: { "render-1": render, "clip-1": clip(commercialUse), "plate-1": plate },
      },
    );
    return {
      result: approveContentTool({ workspaceId, variantId: variant.id }, actorId, dependencies),
      recorded,
    };
  };

  it("refuses a video built on an Agnes clip whose caption has no AI disclosure", async () => {
    const { result, recorded } = run(true, "A useful idea.");
    expect(await result).toEqual({ ok: false, error: "AI_DISCLOSURE_MISSING" });
    expect(recorded()).toBeUndefined();
  });
  it("refuses to approve a TikTok video rendered from an Agnes clip with unverified rights", async () => {
    const { result, recorded } = run(null);
    expect(await result).toEqual({ ok: false, error: "RIGHTS_UNVERIFIED:clip-1" });
    expect(recorded()).toBeUndefined();
  });
  it("refuses when the clip is explicitly not for commercial use", async () => {
    const { result } = run(false);
    expect(await result).toEqual({ ok: false, error: "RIGHTS_UNVERIFIED:clip-1" });
  });
  it("still refuses a clip flagged commercialUse true while its model is off the G0 allowlist", async () => {
    const { result, recorded } = run(true);
    expect(await result).toEqual({ ok: false, error: "RIGHTS_UNVERIFIED:clip-1" });
    expect(recorded()).toBeUndefined();
  });
});

describe("approve_content MCP tool", () => {
  it("stores an approval bound to current asset checksums", async () => {
    const { dependencies, recorded } = fixture(baseVariant);
    const result = await approve(dependencies);
    expect(result).toMatchObject({ ok: true, value: { variant: { state: "approved" } } });
    expect(recorded()?.approval?.assetChecksums).toEqual(["checksum-1"]);
    expect(recorded()?.approval?.publicationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("submits and approves a draft in one call", async () => {
    const { dependencies, recorded } = fixture({ ...baseVariant, state: "draft" });
    const result = await approve(dependencies);
    expect(result).toMatchObject({ ok: true, value: { variant: { state: "approved" } } });
    expect(recorded()?.state).toBe("approved");
    expect(recorded()?.approval?.assetChecksums).toEqual(["checksum-1"]);
  });

  it("approves a rejected variant and drops the rejection reason", async () => {
    const { dependencies, recorded } = fixture({
      ...baseVariant,
      state: "rejected",
      rejectionReason: "typo",
    });
    const result = await approve(dependencies);
    expect(result).toMatchObject({ ok: true });
    expect(recorded()?.rejectionReason).toBeUndefined();
  });

  it("refuses a fidelity-blocked render with FIDELITY_BLOCKED and records nothing", async () => {
    const { dependencies, recorded } = fixture({
      ...baseVariant,
      creativeRender: {
        state: "rendered",
        templateVersions: {},
        rendererVersion: 1,
        brandKitHash: "hash",
        fidelity: { verdict: "block", slides: [] },
      },
    });
    expect(await approve(dependencies)).toEqual({ ok: false, error: "FIDELITY_BLOCKED" });
    expect(recorded()).toBeUndefined();
  });

  it("refuses a generic hook opener with PREPUBLISH_BLOCKED and records nothing", async () => {
    const { dependencies, recorded } = fixture({
      ...baseVariant,
      voiceScript: ["Confira esta oferta imperdivel"],
    });
    expect(await approve(dependencies)).toEqual({ ok: false, error: "PREPUBLISH_BLOCKED" });
    expect(recorded()).toBeUndefined();
  });

  it("refuses a draft whose asset is no longer active and records nothing", async () => {
    const { dependencies, recorded } = fixture(
      { ...baseVariant, state: "draft" },
      { asset: { ...asset, state: "archived" } },
    );
    const result = await approve(dependencies);
    expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(recorded()).toBeUndefined();
  });

  it("refuses a draft whose asset dimensions no longer match the channel", async () => {
    const { dependencies, recorded } = fixture(
      { ...baseVariant, state: "draft" },
      { asset: { ...asset, width: 1080, height: 1080 } },
    );
    const result = await approve(dependencies);
    expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(recorded()).toBeUndefined();
  });

  it.each(["approved", "published", "scheduled", "cancelled"] as const)(
    "returns INVALID_CONTENT for a %s variant",
    async (state) => {
      const { dependencies, recorded } = fixture({ ...baseVariant, state });
      const result = await approve(dependencies);
      expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
      expect(recorded()).toBeUndefined();
    },
  );

  describe("tiktok_shop gate", () => {
    const tiktokChannel: Channel = {
      ...channel,
      kind: "tiktok_video",
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
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
    };
    const shopEnabledStatus = {
      version: 1 as const,
      state: "shop_enabled" as const,
      observedAt: new Date().toISOString(),
      source: "operator_confirmation" as const,
    };
    const tiktokOffer: Offer = {
      id: "offer-2",
      workspaceId,
      marketplace: "tiktok_shop",
      listingUrl: "https://shop.tiktok.com/view/product/1",
      externalProductId: "prod-1",
      title: "Product",
      state: "active",
      activeSnapshotId: "snapshot-2",
      snapshots: [{ id: "snapshot-2", verifiedAt: new Date(), facts: [] }],
    };
    const tiktokVariant: ContentVariant = {
      ...baseVariant,
      channelId: "channel-1",
      assetIds: ["asset-1"],
      offerSnapshotId: "snapshot-2",
    };

    const tiktokFixture = (overrides: {
      channelContext?: Record<string, unknown> | null;
      snapshotVerifiedAt?: Date;
    }) => {
      const { dependencies } = fixture(tiktokVariant, { asset: video });
      return {
        ...dependencies,
        channelRepository: {
          create: async (value: Channel) => value,
          listForWorkspace: async () => [tiktokChannel],
          findForWorkspace: async () => ({
            ...tiktokChannel,
            context: overrides.channelContext,
          }),
          updateStatus: async () => null,
        },
        offerRepository: {
          create: async (value: Offer) => value,
          listForWorkspace: async () => [tiktokOffer],
          findForWorkspace: async () => ({
            ...tiktokOffer,
            snapshots: [
              {
                ...tiktokOffer.snapshots[0],
                verifiedAt: overrides.snapshotVerifiedAt ?? new Date(),
              },
            ],
          }),
          addSnapshot: async () => tiktokOffer,
          activate: async () => tiktokOffer,
          reject: async () => tiktokOffer,
        },
      } as McpDependencies;
    };

    it("returns SHOP_NOT_ENABLED when no status was recorded", async () => {
      const dependencies = tiktokFixture({ channelContext: null });
      const result = await approveContentTool(
        { workspaceId, variantId: tiktokVariant.id },
        actorId,
        dependencies,
      );
      expect(result).toEqual({ ok: false, error: "SHOP_NOT_ENABLED" });
    });

    it("returns COMMERCIAL_SNAPSHOT_STALE when the snapshot is older than 24h", async () => {
      const dependencies = tiktokFixture({
        channelContext: { tiktokShop: shopEnabledStatus },
        snapshotVerifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      const result = await approveContentTool(
        { workspaceId, variantId: tiktokVariant.id },
        actorId,
        dependencies,
      );
      expect(result).toEqual({ ok: false, error: "COMMERCIAL_SNAPSHOT_STALE" });
    });

    it("approves when the shop is enabled and the snapshot is fresh", async () => {
      const dependencies = tiktokFixture({ channelContext: { tiktokShop: shopEnabledStatus } });
      const result = await approveContentTool(
        { workspaceId, variantId: tiktokVariant.id },
        actorId,
        dependencies,
      );
      expect(result).toMatchObject({ ok: true, value: { variant: { state: "approved" } } });
    });
  });
});
