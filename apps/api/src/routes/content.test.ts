import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

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

const createFixture = (): ApiDependencies => {
  const items = new Map<string, ContentItem>();
  const variants = new Map<string, ContentVariant>();
  const assets = new Map<string, Asset>();
  const content: ContentRepository = {
    listContentItemsWithoutActiveVariants: async () => [],
    updateContentItemState: async () => null,
    listVariantsForWorkspace: async () => [],
    createContentItem: async (item) => {
      items.set(item.id, item);
      return item;
    },
    findContentItemForWorkspace: async ({ workspaceId: target, contentItemId }) =>
      target === workspaceId ? (items.get(contentItemId) ?? null) : null,
    createVariant: async (variant) => {
      variants.set(variant.id, variant);
      return variant;
    },
    findVariantForWorkspace: async ({ workspaceId: target, variantId }) =>
      target === workspaceId ? (variants.get(variantId) ?? null) : null,
    findReviewableForWorkspace: async () => [],
    updateVariant: async (variant) => variant,
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant }) => variant,
  };
  const assetRepository: AssetRepository = {
    create: async (value) => {
      assets.set(value.id, value);
      return value;
    },
    findByMetadata: async () => null,
    findForWorkspace: async ({ workspaceId: target, assetId }) =>
      target === workspaceId ? (assets.get(assetId) ?? null) : null,
    updateState: async ({ assetId, state }) => {
      const existing = assets.get(assetId);
      if (!existing) return null;
      const updated = { ...existing, state };
      assets.set(assetId, updated);
      return updated;
    },
    completeRenderedAsset: async () => null,
  };
  const assetStore: AssetStore = {
    createUpload: async () => ({
      method: "PUT",
      url: "https://signed.example/upload",
      headers: { "content-type": "image/jpeg" },
    }),
    createDownload: async () => ({ method: "GET", url: "https://signed.example/download" }),
    verifyUpload: async () => ({
      checksum: "checksum-2",
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
    }),
    putObject: async () => undefined,
    deleteObject: async () => undefined,
  };
  const dependencies = {
    invitation: {} as InvitationDependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async ({ workspaceId: target }: { workspaceId: typeof workspaceId }) =>
        target === workspaceId ? { id: workspaceId, name: "Workspace" } : null,
      findMembership: async ({ workspaceId: target }: { workspaceId: typeof workspaceId }) =>
        target === workspaceId
          ? { workspaceId, userId, role: "operator" as const, status: "active" as const }
          : null,
      addMembership: async () => undefined,
    },
    contentRepository: content,
    assetRepository,
    assetStore,
    offerRepository: {
      create: async (value) => value,
      findForWorkspace: async ({ workspaceId: target }) => (target === workspaceId ? offer : null),
      addSnapshot: async () => null,
      activate: async () => null,
      reject: async () => null,
    } satisfies OfferRepository,
    channelRepository: {
      create: async (value) => value,
      findForWorkspace: async ({ workspaceId: target }) =>
        target === workspaceId ? channel : null,
      updateStatus: async () => null,
    } satisfies ChannelRepository,
    providerConnections: {
      create: async (value) => ({ ok: true as const, connection: value }),
      findAllForWorkspace: async () => [connection],
      findForWorkspace: async ({ workspaceId: target }) =>
        target === workspaceId ? connection : null,
      revoke: async () => undefined,
    } satisfies ProviderConnectionRepository,
    audit: { record: async () => "audit-1" },
    authenticate: async () => ({ userId, verifiedEmail: "operator@example.com" }),
  } as unknown as ApiDependencies;
  return dependencies;
};

describe("content and asset routes", () => {
  it("rejects uploads to a workspace the actor cannot access", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${otherWorkspaceId}/assets`,
      payload: {
        mimeType: "image/jpeg",
        checksum: "checksum-2",
        width: 1080,
        height: 1080,
        provenance: "operator_upload",
        license: "operator-owned",
      },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("creates an asset upload target without exposing storage credentials", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/assets`,
      payload: {
        mimeType: "image/jpeg",
        checksum: "checksum-2",
        width: 1080,
        height: 1080,
        provenance: "operator_upload",
        license: "operator-owned",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().upload).toEqual({
      method: "PUT",
      url: "https://signed.example/upload",
      headers: { "content-type": "image/jpeg" },
    });
    expect(response.body).not.toContain("secret");
    await app.close();
  });

  it("activates an asset only after storage metadata is verified", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/assets`,
      payload: {
        mimeType: "image/jpeg",
        checksum: "checksum-2",
        width: 1080,
        height: 1080,
        provenance: "operator_upload",
        license: "operator-owned",
      },
    });
    const assetId = created.json().asset.id as string;
    const completed = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/assets/${assetId}/complete`,
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json().asset.state).toBe("active");
    await app.close();
  });
});
