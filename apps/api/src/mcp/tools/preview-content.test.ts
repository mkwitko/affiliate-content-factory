import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { McpDependencies } from "../server.js";
import { previewContentTool } from "./preview-content.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const channel: Channel = {
  id: "ch1",
  workspaceId,
  connectionId: "co1",
  kind: "instagram_carousel",
  label: "Feed",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1350 },
  },
};
const asset = (id: string): Asset => ({
  id,
  workspaceId,
  objectKey: `k/${id}`,
  checksum: `sha256:${id}`,
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  provenance: "provider_import",
  commercialUse: null,
  license: "Mercado Livre listing photo",
  state: "active",
});
const variant: ContentVariant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a2", "a1"],
  caption: "#publi Seu notebook fica baixo demais?",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
};
const offer = {
  id: "o1",
  workspaceId,
  affiliateUrl: "https://meli.la/abc",
  activeSnapshotId: "s1",
  snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
};

const dependencies = (withStore: boolean): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
    addMembership: async () => undefined,
  },
  contentRepository: {
    findVariantForWorkspace: async () => variant,
    findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
  } as unknown as NonNullable<McpDependencies["contentRepository"]>,
  channelRepository: {
    create: async (value) => value,
    findForWorkspace: async () => channel,
    updateStatus: async () => null,
  },
  assetRepository: {
    create: async (value) => value,
    findByMetadata: async () => null,
    findForWorkspace: async ({ assetId }) => asset(assetId),
    updateState: async () => null,
    completeRenderedAsset: async () => null,
  },
  ...(withStore
    ? {
        assetStore: {
          createDownload: async ({ assetId }: { assetId: string }) => ({
            method: "GET" as const,
            url: `https://r2.example/${assetId}?sig=1`,
          }),
        } as unknown as NonNullable<McpDependencies["assetStore"]>,
      }
    : {}),
  offerRepository: {
    findForWorkspace: async () => offer,
  } as unknown as NonNullable<McpDependencies["offerRepository"]>,
});

const input = { workspaceId, variantId: "v1" };

describe("preview_content MCP tool", () => {
  it("returns pending while a creative render is still running", async () => {
    const base = dependencies(false);
    const result = await previewContentTool(input, actorId, {
      ...base,
      contentRepository: {
        ...base.contentRepository,
        findVariantForWorkspace: async () => ({
          ...variant,
          creativeRender: {
            state: "pending",
            templateVersions: {},
            rendererVersion: 1,
            brandKitHash: "",
          },
        }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    });

    expect(result).toEqual({ ok: false, error: "PENDING_RENDER" });
  });

  it("returns a stable render failure reason instead of previewing empty assets", async () => {
    const base = dependencies(false);
    const result = await previewContentTool(input, actorId, {
      ...base,
      contentRepository: {
        ...base.contentRepository,
        findVariantForWorkspace: async () => ({
          ...variant,
          assetIds: [],
          creativeRender: {
            state: "failed",
            reason: "layout_failed",
            templateVersions: {},
            rendererVersion: 1,
            brandKitHash: "",
          },
        }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    });

    expect(result).toEqual({ ok: false, error: "RENDER_FAILED:layout_failed" });
  });

  it("returns the caption and one viewable image URL per slide, in slide order", async () => {
    const result = await previewContentTool(input, actorId, dependencies(true));
    expect(result).toMatchObject({
      ok: true,
      value: {
        preview: { caption: "#publi Seu notebook fica baixo demais?" },
        voiceScript: variant.voiceScript,
        slides: [
          {
            position: 1,
            assetId: "a2",
            url: "https://r2.example/a2?sig=1",
            width: 1080,
            height: 1350,
          },
          {
            position: 2,
            assetId: "a1",
            url: "https://r2.example/a1?sig=1",
            width: 1080,
            height: 1350,
          },
        ],
      },
    });
  });

  it("still previews without an asset store, with null image URLs", async () => {
    const result = await previewContentTool(input, actorId, dependencies(false));
    expect(result).toMatchObject({ ok: true, value: { slides: [{ url: null }, { url: null }] } });
  });

  it("derives evidence age and destination fingerprint from the active offer snapshot", async () => {
    const verifiedAt = new Date(Date.now() - 9 * 86_400_000);
    const result = await previewContentTool(input, actorId, {
      ...dependencies(false),
      offerRepository: {
        findForWorkspace: async () => ({
          ...offer,
          snapshots: [{ ...offer.snapshots[0], verifiedAt }],
        }),
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        preview: {
          evidenceAgeDays: 9,
          destinationFingerprint: createHash("sha256").update("https://meli.la/abc").digest("hex"),
          warnings: expect.arrayContaining(["evidence_expired"]),
        },
      },
    });
  });

  it("previews a tiktok_shop offer with no affiliate URL, fingerprinted from its externalProductId", async () => {
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
    const video = { ...asset("v1"), mimeType: "video/mp4", width: 1080, height: 1920 };
    const result = await previewContentTool(input, actorId, {
      ...dependencies(false),
      channelRepository: {
        create: async (value) => value,
        findForWorkspace: async () => tiktokChannel,
        updateStatus: async () => null,
      },
      contentRepository: {
        findVariantForWorkspace: async () => ({ ...variant, assetIds: ["v1"] }),
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
      assetRepository: {
        create: async (value) => value,
        findByMetadata: async () => null,
        findForWorkspace: async () => video,
        updateState: async () => null,
        completeRenderedAsset: async () => null,
      },
      offerRepository: {
        findForWorkspace: async () => ({
          id: "o1",
          marketplace: "tiktok_shop",
          externalProductId: "tt-1",
          activeSnapshotId: "s1",
          snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
        }),
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        preview: {
          destinationFingerprint: createHash("sha256")
            .update("tiktokshop:product/tt-1")
            .digest("hex"),
        },
        affiliateUrl: null,
      },
    });
  });

  it("returns tiktokShop null for a non-tiktok_shop offer", async () => {
    const result = await previewContentTool(input, actorId, dependencies(false));
    expect(result).toMatchObject({ ok: true, value: { tiktokShop: null } });
  });

  it("returns tiktokShop details and warns when the shop is not confirmed enabled", async () => {
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
    const video = { ...asset("v1"), mimeType: "video/mp4", width: 1080, height: 1920 };
    const result = await previewContentTool(input, actorId, {
      ...dependencies(false),
      channelRepository: {
        create: async (value) => value,
        findForWorkspace: async () => tiktokChannel,
        updateStatus: async () => null,
      },
      contentRepository: {
        findVariantForWorkspace: async () => ({ ...variant, assetIds: ["v1"] }),
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
      assetRepository: {
        create: async (value) => value,
        findByMetadata: async () => null,
        findForWorkspace: async () => video,
        updateState: async () => null,
        completeRenderedAsset: async () => null,
      },
      offerRepository: {
        findForWorkspace: async () => ({
          id: "o1",
          marketplace: "tiktok_shop",
          externalProductId: "tt-1",
          title: "Product",
          activeSnapshotId: "s1",
          snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
        }),
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        tiktokShop: { externalProductId: "tt-1", title: "Product", attach: "manual" },
        preview: { warnings: expect.arrayContaining(["shop_status_not_enabled"]) },
      },
    });
  });

  it("does not warn when the shop status is recorded and enabled within 30 days", async () => {
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
      context: {
        tiktokShop: {
          version: 1,
          state: "shop_enabled",
          observedAt: new Date().toISOString(),
          source: "operator_confirmation",
        },
      },
    };
    const video = { ...asset("v1"), mimeType: "video/mp4", width: 1080, height: 1920 };
    const result = await previewContentTool(input, actorId, {
      ...dependencies(false),
      channelRepository: {
        create: async (value) => value,
        findForWorkspace: async () => tiktokChannel,
        updateStatus: async () => null,
      },
      contentRepository: {
        findVariantForWorkspace: async () => ({ ...variant, assetIds: ["v1"] }),
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
      assetRepository: {
        create: async (value) => value,
        findByMetadata: async () => null,
        findForWorkspace: async () => video,
        updateState: async () => null,
        completeRenderedAsset: async () => null,
      },
      offerRepository: {
        findForWorkspace: async () => ({
          id: "o1",
          marketplace: "tiktok_shop",
          externalProductId: "tt-1",
          title: "Product",
          activeSnapshotId: "s1",
          snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
        }),
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    });
    if (!result.ok) throw new Error("expected ok");
    const warnings = (result.value as { preview: { warnings: string[] } }).preview.warnings;
    expect(warnings).not.toContain("shop_status_not_enabled");
  });

  it("rejects caller-supplied evidence metadata", async () => {
    const result = await previewContentTool(
      { ...input, evidenceVerifiedAt: new Date().toISOString(), destinationFingerprint: "forged" },
      actorId,
      dependencies(false),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("echoes the variant's voice script", async () => {
    const withVoiceScript = { ...variant, voiceScript: ["Frase um.", "Frase dois."] };
    const deps = dependencies(true);
    const result = await previewContentTool(input, actorId, {
      ...deps,
      contentRepository: {
        ...deps.contentRepository,
        findVariantForWorkspace: async () => withVoiceScript,
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { voiceScript: ["Frase um.", "Frase dois."] },
    });
  });

  it("warns about a caption number that the offer snapshot does not back", async () => {
    const url = "https://www.mercadolivre.com.br/p/MLB1";
    const result = await previewContentTool(input, actorId, {
      ...dependencies(false),
      contentRepository: {
        findVariantForWorkspace: async () => ({ ...variant, caption: "#publi Só R$ 29,90" }),
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
      offerRepository: {
        findForWorkspace: async () => ({
          id: "o1",
          affiliateUrl: "https://meli.la/abc",
          activeSnapshotId: "s1",
          snapshots: [
            {
              id: "s1",
              verifiedAt: new Date(),
              facts: [
                {
                  key: "current_price",
                  value: { amountMinor: 3790, currency: "BRL" },
                  sourceUrl: url,
                  verified: true,
                },
              ],
            },
          ],
        }),
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        preview: {
          warnings: ["number_without_evidence:R$ 29,90", "cta_missing"],
        },
      },
    });
  });

  it("warns similar_to_recent from the last approved/published captions on the same channel, excluding itself and other channels", async () => {
    const base = dependencies(false);
    const recentSameChannel = {
      ...variant,
      id: "v-recent",
      state: "approved" as const,
      caption: variant.caption,
    };
    const recentOtherChannel = {
      ...variant,
      id: "v-other-channel",
      channelId: "ch2",
      state: "approved" as const,
      caption: variant.caption,
    };
    const selfAsApproved = { ...variant, state: "approved" as const };
    const result = await previewContentTool(input, actorId, {
      ...base,
      contentRepository: {
        ...base.contentRepository,
        listVariantsForWorkspace: async () => [
          recentSameChannel,
          recentOtherChannel,
          selfAsApproved,
        ],
      } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { preview: { warnings: expect.arrayContaining(["similar_to_recent"]) } },
    });
  });
});
