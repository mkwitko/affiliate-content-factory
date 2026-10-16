import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant, VariantApproval } from "@money-maker/core/content/content";
import type { McpDependencies } from "../server.js";
import { getStoryKitTool } from "./get-story-kit.js";

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
  assetIds: ["a2", "a1"],
  caption: "#publi Seu notebook fica baixo demais?",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
  approval,
};
const { approval: _approval, ...unapprovedVariant } = approvedVariant;
const draftVariant: ContentVariant = { ...unapprovedVariant, state: "draft" };

const dependencies = (
  overrides: Record<string, unknown> = {},
  role: "owner" | "operator" | "reviewer" | "other" = "owner",
): McpDependencies =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () =>
        role === "other" ? null : { workspaceId, userId: actorId, role, status: "active" },
    },
    contentRepository: {
      findVariantForWorkspace: async () => approvedVariant,
      findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
    },
    channelRepository: { findForWorkspace: async () => storiesChannel },
    assetStore: {
      createDownload: async ({ assetId }: { assetId: string }) => ({
        method: "GET" as const,
        url: `https://r2.example/${assetId}?sig=1`,
      }),
    } as unknown as NonNullable<McpDependencies["assetStore"]>,
    offerRepository: {
      findForWorkspace: async () => ({ id: "o1", affiliateUrl: "https://meli.la/abc" }),
    } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    ...overrides,
  }) as unknown as McpDependencies;

const input = { workspaceId, variantId: "v1" };

describe("get_story_kit", () => {
  it("returns slides in order, the official affiliate link, caption, and sticker text", async () => {
    const result = await getStoryKitTool(input, actorId, dependencies());
    expect(result).toEqual({
      ok: true,
      value: {
        slides: [
          { position: 1, assetId: "a2", url: "https://r2.example/a2?sig=1" },
          { position: 2, assetId: "a1", url: "https://r2.example/a1?sig=1" },
        ],
        affiliateUrl: "https://meli.la/abc",
        caption: "#publi Seu notebook fica baixo demais?",
        stickerText: "Ver oferta",
      },
    });
  });

  it("rejects invalid arguments", async () => {
    const result = await getStoryKitTool({ workspaceId }, actorId, dependencies());
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const result = await getStoryKitTool(input, actorId, dependencies({}, "other"));
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("refuses a channel that is not instagram_stories", async () => {
    const result = await getStoryKitTool(
      input,
      actorId,
      dependencies({
        channelRepository: {
          findForWorkspace: async () => ({ ...storiesChannel, kind: "threads" }),
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: "CHANNEL_NOT_STORIES" });
  });

  it("refuses a variant that is not approved", async () => {
    const result = await getStoryKitTool(
      input,
      actorId,
      dependencies({
        contentRepository: { findVariantForWorkspace: async () => draftVariant },
      }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_APPROVED" });
  });

  it("returns CONTENT_NOT_FOUND when the offer has no official affiliate link", async () => {
    const result = await getStoryKitTool(
      input,
      actorId,
      dependencies({
        offerRepository: {
          findForWorkspace: async () => null,
        } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });

  it("returns CONTENT_NOT_FOUND for a missing variant", async () => {
    const result = await getStoryKitTool(
      input,
      actorId,
      dependencies({ contentRepository: { findVariantForWorkspace: async () => null } }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });
});
