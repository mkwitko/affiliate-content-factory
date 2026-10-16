import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant, VariantApproval } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import type {
  CreateManualPublicationInput,
  PublicationAttempt,
} from "@money-maker/core/publishing/publication";
import type { McpDependencies } from "../server.js";
import { recordManualPublicationTool } from "./record-manual-publication.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const storiesChannel: Channel = {
  id: "ch1",
  workspaceId,
  connectionId: "co1",
  kind: "instagram_stories",
  label: "Stories",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 1000,
    requiredAssetDimensions: { width: 1080, height: 1920 },
  },
};
const approval: VariantApproval = {
  id: "approval-1",
  workspaceId,
  variantId: "v1",
  actorId: "owner-1",
  assetChecksums: ["sha256:a1"],
  offerSnapshotId: "s1",
  publicationFingerprint: null,
  policyVersion: 1,
  decidedAt: new Date("2026-09-23T09:00:00Z"),
};
const approvedVariant: ContentVariant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "#publi x",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
  approval,
};
const { approval: _approval, ...unapprovedVariant } = approvedVariant;
const draftVariant: ContentVariant = { ...unapprovedVariant, state: "draft" };
// The default content item cites "offer-1"; most tests only care about the manual-publication
// path, so this stands in as a plain (non-TikTok-Shop) offer that never trips the shop gate.
const mercadoLivreOffer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://produto.mercadolivre.com.br/1",
  affiliateUrl: "https://meli.la/abc",
  title: "Product",
  state: "active",
  activeSnapshotId: "snapshot-1",
  snapshots: [{ id: "snapshot-1", verifiedAt: new Date(), facts: [] }],
};
const defaultOfferRepository = {
  findForWorkspace: async () => mercadoLivreOffer,
} as unknown as NonNullable<McpDependencies["offerRepository"]>;

const fixture = (
  overrides: Record<string, unknown> = {},
  role: "owner" | "operator" | "reviewer" | "other" = "owner",
) => {
  const byKey = new Map<string, PublicationAttempt>();
  const calls: CreateManualPublicationInput[] = [];
  const publicationAttempts = {
    createOrFindManualPublication: async (input: CreateManualPublicationInput) => {
      calls.push(input);
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return { created: false, attempt: existing };
      const attempt: PublicationAttempt = {
        attemptId: input.attemptId,
        workspaceId: input.workspaceId,
        contentVariantId: input.contentVariantId,
        channelId: input.channelId,
        connectionId: input.connectionId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        correlationId: input.correlationId,
        status: "published",
        attemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      byKey.set(input.idempotencyKey, attempt);
      return { created: true, attempt };
    },
  } as unknown as NonNullable<McpDependencies["publicationAttempts"]>;
  const dependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () =>
        role === "other" ? null : { workspaceId, userId: actorId, role, status: "active" },
    },
    contentRepository: {
      findVariantForWorkspace: async () => approvedVariant,
      findContentItemForWorkspace: async () => ({ id: "c1", offerId: "offer-1" }),
    },
    channelRepository: { findForWorkspace: async () => storiesChannel },
    offerRepository: defaultOfferRepository,
    publicationAttempts,
    ...overrides,
  } as unknown as McpDependencies;
  return { dependencies, calls };
};

const input = { workspaceId, variantId: "v1" };

describe("record_manual_publication", () => {
  it("creates a published attempt with no externalId", async () => {
    const { dependencies } = fixture();
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toMatchObject({
      ok: true,
      value: { created: true, publication: { status: "published", channelId: "ch1" } },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(
      (result.value as { publication: PublicationAttempt }).publication.externalId,
    ).toBeUndefined();
  });

  it("blocks editorial manual publication before creating an attempt", async () => {
    const { dependencies, calls } = fixture({
      contentRepository: {
        findVariantForWorkspace: async () => approvedVariant,
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: null }),
      },
    });
    await expect(recordManualPublicationTool(input, actorId, dependencies)).resolves.toEqual({
      ok: false,
      error: "EDITORIAL_PUBLICATION_NOT_ENABLED",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid arguments", async () => {
    const { dependencies } = fixture();
    const result = await recordManualPublicationTool({ workspaceId }, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const { dependencies } = fixture({}, "other");
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("denies a reviewer (owner/operator only)", async () => {
    const { dependencies } = fixture({}, "reviewer");
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("refuses a channel with no manual publication path", async () => {
    const { dependencies } = fixture({
      channelRepository: { findForWorkspace: async () => ({ ...storiesChannel, kind: "threads" }) },
    });
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "CHANNEL_NOT_MANUAL" });
  });

  it("accepts an approved tiktok_video variant", async () => {
    const tiktokChannel: Channel = { ...storiesChannel, kind: "tiktok_video" };
    const { dependencies } = fixture({
      channelRepository: { findForWorkspace: async () => tiktokChannel },
    });
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toMatchObject({
      ok: true,
      value: { created: true, publication: { status: "published", channelId: "ch1" } },
    });
  });

  it("accepts editorial (no-offer) TikTok growth content on tiktok_video, unlike instagram_stories", async () => {
    const tiktokChannel: Channel = { ...storiesChannel, kind: "tiktok_video" };
    const { dependencies, calls } = fixture({
      channelRepository: { findForWorkspace: async () => tiktokChannel },
      contentRepository: {
        findVariantForWorkspace: async () => approvedVariant,
        findContentItemForWorkspace: async () => ({ id: "c1", offerId: null }),
      },
    });
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toMatchObject({ ok: true, value: { created: true } });
    expect(calls).toHaveLength(1);
  });

  it("refuses a variant that is not approved", async () => {
    const { dependencies } = fixture({
      contentRepository: { findVariantForWorkspace: async () => draftVariant },
    });
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_APPROVED" });
  });

  it("returns CONTENT_NOT_FOUND for a missing variant", async () => {
    const { dependencies } = fixture({
      contentRepository: { findVariantForWorkspace: async () => null },
    });
    const result = await recordManualPublicationTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });

  describe("tiktok_shop gate", () => {
    const tiktokChannel: Channel = { ...storiesChannel, kind: "tiktok_video" };
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

    it("returns SHOP_NOT_ENABLED when no status was recorded", async () => {
      const { dependencies, calls } = fixture({
        channelRepository: { findForWorkspace: async () => ({ ...tiktokChannel, context: null }) },
        offerRepository: { findForWorkspace: async () => tiktokOffer },
      });
      const result = await recordManualPublicationTool(input, actorId, dependencies);
      expect(result).toEqual({ ok: false, error: "SHOP_NOT_ENABLED" });
      expect(calls).toHaveLength(0);
    });

    it("returns COMMERCIAL_SNAPSHOT_STALE when the snapshot is older than 24h", async () => {
      const { dependencies, calls } = fixture({
        channelRepository: {
          findForWorkspace: async () => ({
            ...tiktokChannel,
            context: { tiktokShop: shopEnabledStatus },
          }),
        },
        offerRepository: {
          findForWorkspace: async () => ({
            ...tiktokOffer,
            snapshots: [
              {
                ...tiktokOffer.snapshots[0],
                verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
              },
            ],
          }),
        },
      });
      const result = await recordManualPublicationTool(input, actorId, dependencies);
      expect(result).toEqual({ ok: false, error: "COMMERCIAL_SNAPSHOT_STALE" });
      expect(calls).toHaveLength(0);
    });

    it("records the manual publication when the shop is enabled and the snapshot is fresh", async () => {
      const { dependencies } = fixture({
        channelRepository: {
          findForWorkspace: async () => ({
            ...tiktokChannel,
            context: { tiktokShop: shopEnabledStatus },
          }),
        },
        offerRepository: { findForWorkspace: async () => tiktokOffer },
      });
      const result = await recordManualPublicationTool(input, actorId, dependencies);
      expect(result).toMatchObject({ ok: true, value: { created: true } });
    });
  });

  it("is idempotent per variant: a repeat call returns the first attempt", async () => {
    const { dependencies, calls } = fixture();
    const first = await recordManualPublicationTool(input, actorId, dependencies);
    const second = await recordManualPublicationTool(input, actorId, dependencies);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.value).toMatchObject({ created: true });
    expect(second.value).toMatchObject({ created: false });
    expect((second.value as { publication: PublicationAttempt }).publication.attemptId).toBe(
      (first.value as { publication: PublicationAttempt }).publication.attemptId,
    );
    expect(calls.every((call) => call.idempotencyKey === "manual:v1")).toBe(true);
  });
});
