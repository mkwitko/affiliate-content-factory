import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { Asset } from "@money-maker/core/assets/asset";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Niche } from "@money-maker/core/niches/niche";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const activeOffer: Offer = {
  id: "offer-active",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://market.example/active",
  affiliateUrl: "https://affiliate.example/active",
  title: "Active offer",
  currentPrice: { amountMinor: 1000, currency: "BRL" },
  state: "active",
  activeSnapshotId: "snapshot-1",
  snapshots: [
    {
      id: "snapshot-1",
      verifiedAt: new Date("2026-09-20T12:00:00.000Z"),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 1000, currency: "BRL" },
          sourceUrl: "https://market.example/active",
          verified: true,
        },
      ],
    },
  ],
};

const inactiveOffer: Offer = {
  ...activeOffer,
  id: "offer-draft",
  title: "Draft offer",
  state: "draft",
  snapshots: [],
};

const niche: Niche = {
  id: "niche-1",
  workspaceId,
  name: "Home office",
  audience: "Operators",
  problem: "Too many tabs",
  editorialVoice: "Practical",
  languages: ["pt-BR"],
  monetizationHypothesis: "Affiliate offers",
  state: "active",
  kind: "affiliate",
};

const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel",
  label: "Instagram carousel",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/png"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1080 },
  },
};

const asset: Asset = {
  id: "asset-1",
  workspaceId,
  objectKey: "workspaces/private/object-key",
  checksum: "checksum-1",
  mimeType: "image/png",
  width: 1080,
  height: 1080,
  provenance: "operator_upload",
  commercialUse: null,
  license: "operator-owned",
  state: "active",
};

const contentItem: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: niche.id,
  offerId: activeOffer.id,
  offerSnapshotId: "snapshot-1",
  title: "Draft content",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "A practical angle",
  state: "draft",
};

const variant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: contentItem.id,
  channelId: channel.id,
  offerSnapshotId: "snapshot-1",
  assetIds: [asset.id],
  caption: "A draft caption",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
};

const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  status: "active",
  accountId: "account-1",
  secretReference: "secret://workspace/private",
};

const createFixture = (): ApiDependencies => ({
  invitation: {} as ApiDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async ({ workspaceId: targetWorkspaceId }) =>
      targetWorkspaceId === workspaceId ? { id: workspaceId, name: "Workspace" } : null,
    findMembership: async ({ workspaceId: targetWorkspaceId }) =>
      targetWorkspaceId === workspaceId
        ? ({
            workspaceId,
            userId,
            role: "operator",
            status: "active",
          } satisfies WorkspaceMembership)
        : null,
    addMembership: async () => undefined,
  },
  nicheRepository: {
    listForWorkspace: async () => [niche],
  } as unknown as NonNullable<ApiDependencies["nicheRepository"]>,
  offerRepository: {
    listForWorkspace: async () => [activeOffer, inactiveOffer],
  } as unknown as NonNullable<ApiDependencies["offerRepository"]>,
  channelRepository: {
    listForWorkspace: async () => [channel],
  } as unknown as NonNullable<ApiDependencies["channelRepository"]>,
  assetRepository: {
    listForWorkspace: async () => [asset],
  } as unknown as NonNullable<ApiDependencies["assetRepository"]>,
  contentRepository: {
    listContentItemsForWorkspace: async () => [contentItem],
    listVariantsForWorkspace: async () => [variant],
  } as unknown as NonNullable<ApiDependencies["contentRepository"]>,
  providerConnections: {
    create: async () => ({ ok: true, connection }),
    findAllForWorkspace: async () => [connection],
    findForWorkspace: async () => connection,
    revoke: async () => undefined,
  },
  authenticate: async () => ({ userId, verifiedEmail: "operator@example.com" }),
});

describe("operator workspace route", () => {
  it("returns named workspace selections and redacts provider and storage secrets", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/operator-context`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      niches: [{ id: "niche-1", name: "Home office" }],
      offers: [{ id: "offer-active", title: "Active offer" }],
      channels: [{ id: "channel-1", label: "Instagram carousel" }],
      assets: [{ id: "asset-1", checksum: "checksum-1" }],
      contentItems: [{ id: "content-1", title: "Draft content" }],
      variants: [{ id: "variant-1", caption: "A draft caption" }],
      connections: [{ id: "connection-1", accountId: "account-1" }],
    });
    expect(response.body).not.toContain("offer-draft");
    expect(response.body).not.toContain("secretReference");
    expect(response.body).not.toContain("secret://workspace/private");
    expect(response.body).not.toContain("workspaces/private/object-key");
    await app.close();
  });

  it("does not disclose another workspace", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${otherWorkspaceId}/operator-context`,
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
