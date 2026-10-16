import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";
import { describe, expect, it } from "vitest";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const otherWorkspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");

const variant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: "channel-1",
  offerSnapshotId: "snapshot-1",
  assetIds: ["asset-1"],
  caption: "A useful product idea.",
  language: "pt-BR",
  state: "ready_for_review",
  voiceScript: [],
};
const item: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: "niche-1",
  offerId: "offer-1",
  offerSnapshotId: "snapshot-1",
  title: "Content item",
  sourceFactKeys: ["seller"],
  creativeOpinion: "A practical angle.",
  state: "draft",
};
const asset: Asset = {
  id: "asset-1",
  workspaceId,
  objectKey: "workspaces/11111111-1111-4111-8111-111111111111/assets/asset-1",
  checksum: "checksum-1",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  provenance: "operator_upload",
  commercialUse: null,
  license: "operator-owned",
  state: "active",
};
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://mercadolivre.example/item/1",
  affiliateUrl: "https://affiliate.example/item/1",
  title: "Example product",
  state: "active",
  snapshots: [
    {
      id: "snapshot-1",
      verifiedAt: new Date("2026-09-20T12:00:00.000Z"),
      facts: [],
    },
  ],
  activeSnapshotId: "snapshot-1",
};
const channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel" as const,
  label: "Instagram carousel",
  status: "active" as const,
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1080 },
  },
};

const createFixture = (
  targetVariant: ContentVariant = variant,
  assetsById: Readonly<Record<string, Asset>> = {},
): ApiDependencies => {
  let storedVariant = targetVariant;
  const content: ContentRepository = {
    listContentItemsWithoutActiveVariants: async () => [],
    updateContentItemState: async () => null,
    listVariantsForWorkspace: async () => [],
    createContentItem: async (value) => value,
    findContentItemForWorkspace: async () => item,
    createVariant: async (value) => value,
    findVariantForWorkspace: async ({ workspaceId: target }) =>
      target === workspaceId ? storedVariant : null,
    findReviewableForWorkspace: async () => [storedVariant],
    updateVariant: async (value) => {
      storedVariant = value;
      return value;
    },
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant }) => {
      storedVariant = variant;
      return variant;
    },
  };
  const dependencies = {
    invitation: {} as InvitationDependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async ({ workspaceId: target }: { workspaceId: typeof workspaceId }) =>
        target === workspaceId ? { id: workspaceId, name: "Workspace" } : null,
      findMembership: async ({ workspaceId: target }: { workspaceId: typeof workspaceId }) =>
        target === workspaceId
          ? { workspaceId, userId, role: "reviewer" as const, status: "active" as const }
          : null,
      addMembership: async () => undefined,
    },
    contentRepository: content,
    assetRepository: {
      create: async (value) => value,
      findByMetadata: async () => null,
      findForWorkspace: async ({ workspaceId: target, assetId }) =>
        target === workspaceId ? (assetsById[assetId] ?? asset) : null,
      updateState: async () => null,
      completeRenderedAsset: async () => null,
    } satisfies AssetRepository,
    offerRepository: {
      create: async (value) => value,
      findForWorkspace: async () => offer,
      addSnapshot: async () => null,
      activate: async () => null,
      reject: async () => null,
    } satisfies OfferRepository,
    channelRepository: {
      create: async (value) => value,
      findForWorkspace: async () => channel,
      updateStatus: async () => null,
    } satisfies ChannelRepository,
    providerConnections: {
      findForWorkspace: async () => ({ id: "connection-1", status: "active" }),
    } as unknown as ProviderConnectionRepository,
    publicationPolicyRepository: {
      findForWorkspace: async () => ({ workspaceId, mode: "manual" as const, version: 1 }),
      create: async (value) => value,
      update: async (value) => value,
    } satisfies PublicationPolicyRepository,
    authenticate: async () => ({ userId, verifiedEmail: "reviewer@example.com" }),
  } as unknown as ApiDependencies;
  return dependencies;
};

describe("approval routes", () => {
  it("returns an exact redacted review snapshot", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/content/review-queue`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      variants: [
        {
          id: "variant-1",
          caption: "A useful product idea.",
          assetChecksums: ["checksum-1"],
          offerSnapshotId: "snapshot-1",
          evidenceVerifiedAt: "2026-09-20T12:00:00.000Z",
          affiliateUrl: "https://affiliate.example/item/1",
          policyMode: "manual",
          channelLabel: "Instagram carousel",
          channelKind: "instagram_carousel",
          state: "ready_for_review",
        },
      ],
    });
    await app.close();
  });

  it("does not reveal a variant from another workspace", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${otherWorkspaceId}/content/variants/${variant.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("approves a ready variant with current asset checksums and policy version", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/content/variants/${variant.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().variant).toMatchObject({ state: "approved" });
    await app.close();
  });

  it("refuses to approve media rendered from a scene clip with unverified rights, on any channel", async () => {
    const render: Asset = {
      ...asset,
      provenance: "rendered",
      license: "Rendered from approved script and storyboard",
      metadata: { sourceAssetIds: ["clip-1"] },
    };
    const clip = (commercialUse: boolean | null): Asset => ({
      ...asset,
      id: "clip-1",
      provenance: "generated",
      license: "internal",
      commercialUse,
      metadata: { role: "stage_artifact", stage: "scene_clip" },
    });
    const approve = async (
      commercialUse: boolean | null,
      caption = `${variant.caption} Cenas geradas por IA.`,
    ) => {
      const app = buildApp(
        createFixture(
          { ...variant, caption },
          { "asset-1": render, "clip-1": clip(commercialUse) },
        ),
      );
      await app.ready();
      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/content/variants/${variant.id}/approve`,
        payload: {},
      });
      await app.close();
      return response;
    };
    const blocked = await approve(null);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error?.code ?? blocked.json().code).toBe(
      "GENERATED_CLIP_RIGHTS_UNVERIFIED",
    );
    // the commercialUse flag alone never clears G0; only the model allowlist does
    expect((await approve(true)).statusCode).toBe(409);
    // Agnes terms 6.1: a caption without an AI disclosure is refused first
    const undisclosed = await approve(true, variant.caption);
    expect(undisclosed.statusCode).toBe(409);
    expect(undisclosed.json().error?.code ?? undisclosed.json().code).toBe("AI_DISCLOSURE_MISSING");
  });

  it("rejects one scene only with a reason, and only where the slide has a scene", async () => {
    const fixture = createFixture();
    const app = buildApp({
      ...fixture,
      assetRepository: {
        ...fixture.assetRepository,
        updateMetadata: async () => null,
        listByMetadata: async () => [],
      },
      jobQueue: { enqueue: async () => ({}) },
    } as unknown as ApiDependencies);
    await app.ready();
    const url = `/v1/workspaces/${workspaceId}/content/items/${item.id}/scenes/reject`;
    const empty = await app.inject({
      method: "POST",
      url,
      payload: { slideIndex: 2, canvas: "feed" },
    });
    expect(empty.statusCode).toBe(400);
    const noScene = await app.inject({
      method: "POST",
      url,
      payload: { slideIndex: 2, canvas: "feed", reasons: ["BAD_PRODUCT"] },
    });
    expect(noScene.statusCode).toBe(409);
    expect(noScene.json().error?.code ?? noScene.json().code).toBe("NO_SCENE");
    await app.close();
  });

  it("approves a rendered draft in one call by submitting it for review first", async () => {
    const app = buildApp(createFixture({ ...variant, state: "draft" }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/content/variants/${variant.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().variant).toMatchObject({ state: "approved" });
    await app.close();
  });

  it("rejects a variant that is not ready for review", async () => {
    const app = buildApp(createFixture({ ...variant, state: "approved" }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/content/variants/${variant.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
