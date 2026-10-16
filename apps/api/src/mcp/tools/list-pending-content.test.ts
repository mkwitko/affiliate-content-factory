import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import type { PublicationAttempt } from "@money-maker/core/publishing/publication";
import type { McpDependencies } from "../server.js";
import { listPendingContentTool } from "./list-pending-content.js";

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
const storiesChannel: Channel = {
  id: "ch2",
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
const item: ContentItem = {
  id: "c1",
  workspaceId,
  nicheId: "n1",
  offerId: "o1",
  offerSnapshotId: "s1",
  title: "Post",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
};
const offer = {
  id: "o1",
  workspaceId,
  title: "Suporte de notebook",
  affiliateUrl: "https://meli.la/abc",
  snapshots: [{ id: "s1", verifiedAt: new Date("2026-09-23T09:00:00Z"), facts: [] }],
} as unknown as Offer;
const listCalls: unknown[] = [];
const draft: ContentVariant = {
  id: "v-draft",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "x",
  language: "pt-BR",
  state: "draft",
  creativeRender: { state: "pending", templateVersions: {}, rendererVersion: 1, brandKitHash: "" },
  voiceScript: [],
  design: { canvaDesignId: "DAF1", pages: [1], width: 1080, height: 1350 },
};
const { design: _design, ...plain } = draft;
const variants: ContentVariant[] = [
  draft,
  { ...plain, id: "v-approved-published", state: "approved" },
  { ...plain, id: "v-published", state: "published" },
  { ...plain, id: "v-unknown", state: "approved" },
  { ...plain, id: "v-stories", channelId: "ch2", state: "approved" },
];
const attempt = (variantId: string, status: PublicationAttempt["status"]): PublicationAttempt => ({
  attemptId: `at-${variantId}`,
  workspaceId,
  contentVariantId: variantId,
  channelId: "ch1",
  connectionId: "co1",
  idempotencyKey: "k",
  requestFingerprint: "f",
  correlationId: "c",
  status,
  attemptCount: 1,
  createdAt: new Date("2026-09-23T10:00:00Z"),
  updatedAt: new Date("2026-09-23T10:05:00Z"),
});

const dependencies = (member: boolean): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () =>
      member ? { workspaceId, userId: actorId, role: "reviewer", status: "active" } : null,
    addMembership: async () => undefined,
  },
  contentRepository: {
    listContentItemsWithoutActiveVariants: async () => [
      { ...item, id: "c-orphan", title: "Primeiro post Instagram" },
    ],
    updateContentItemState: async () => null,
    createContentItem: async (value) => value,
    findContentItemForWorkspace: async () => item,
    createVariant: async (value) => value,
    listVariantsForWorkspace: async (_workspaceId, options) => {
      listCalls.push(options);
      return variants;
    },
    findVariantForWorkspace: async () => null,
    findReviewableForWorkspace: async () => [],
    updateVariant: async (value) => value,
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant }) => variant,
  },
  channelRepository: {
    create: async (value) => value,
    findForWorkspace: async () => channel,
    listForWorkspace: async () => [channel, storiesChannel],
    updateStatus: async () => null,
  },
  offerRepository: {
    findForWorkspace: async () => offer,
  } as unknown as NonNullable<McpDependencies["offerRepository"]>,
  publicationAttempts: {
    listLatestForVariants: async () =>
      new Map([
        ["v-approved-published", attempt("v-approved-published", "published")],
        ["v-unknown", attempt("v-unknown", "unknown_outcome")],
      ]),
  } as unknown as NonNullable<McpDependencies["publicationAttempts"]>,
});

describe("list_pending_content", () => {
  it("lists unfinished variants with a next action and edit link", async () => {
    const result = await listPendingContentTool({ workspaceId }, actorId, dependencies(true));
    if (!result.ok) throw new Error("expected ok");
    const items = (result.value as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((entry) => [entry.kind, entry.variantId, entry.nextAction])).toEqual([
      ["variant", "v-draft", "approve"],
      ["variant", "v-unknown", "reconcile"],
      ["variant", "v-stories", "manual_story"],
      ["content_item", null, "build"],
    ]);
    expect(items[0]).toMatchObject({ caption: "x", assetCount: 1 });
    expect(items[0]).toMatchObject({
      creativeRender: { state: "pending", reason: null, fidelity: null },
    });
    expect(items[2]).toMatchObject({
      variantId: "v-stories",
      channelId: "ch2",
      channelKind: "instagram_stories",
      nextAction: "manual_story",
    });
    expect(items[3]).toMatchObject({
      contentItemId: "c-orphan",
      title: "Primeiro post Instagram",
      offerId: "o1",
      offerTitle: "Suporte de notebook",
      channelId: null,
      caption: null,
      assetCount: 0,
    });
    expect(items[0]).toMatchObject({
      channelName: "Feed",
      channelKind: "instagram_carousel",
      offerTitle: "Suporte de notebook",
      editUrl: "https://www.canva.com/design/DAF1/edit",
      attempt: null,
      offerId: "o1",
      evidenceVerifiedAt: "2026-09-23T09:00:00.000Z",
      affiliateUrl: "https://meli.la/abc",
    });
    expect(items[1]).toMatchObject({
      editUrl: null,
      attempt: { attemptId: "at-v-unknown", status: "unknown_outcome" },
    });
  });

  it("still lists a variant whose stored fidelity slides are corrupted", async () => {
    const original = variants[0] as ContentVariant;
    variants[0] = {
      ...original,
      creativeRender: {
        ...original.creativeRender,
        fidelity: { verdict: "warn", slides: null },
      },
    } as unknown as ContentVariant;
    try {
      const result = await listPendingContentTool({ workspaceId }, actorId, dependencies(true));
      if (!result.ok) throw new Error("expected ok");
      const items = (result.value as { items: Array<Record<string, unknown>> }).items;
      expect(items[0]).toMatchObject({
        creativeRender: { fidelity: { verdict: "warn", slides: [] } },
      });
    } finally {
      variants[0] = original;
    }
  });

  it("asks the repository only for unfinished variants, capped", async () => {
    listCalls.length = 0;
    await listPendingContentTool({ workspaceId }, actorId, dependencies(true));
    expect(listCalls).toEqual([
      { states: ["draft", "ready_for_review", "rejected", "approved"], limit: 50 },
    ]);
  });

  it("denies non-members", async () => {
    const result = await listPendingContentTool({ workspaceId }, actorId, dependencies(false));
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
