import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { McpDependencies } from "../server.js";
import { renderReelTool } from "./render-reel.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const sourceVariantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const carouselChannel: Channel = {
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
  },
};
const approvedVariant: ContentVariant = {
  id: sourceVariantId,
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1", "a2"],
  caption: "#publi x",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
};

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
      findContentItemForWorkspace: async () => ({ creativeSlides: undefined }),
    },
    channelRepository: { findForWorkspace: async () => carouselChannel },
    reelRenders: {
      createPending: vi.fn(
        async ({ id, voiceMode }: { id: string; voiceMode: "script" | "none" }) => ({
          created: true,
          render: {
            id,
            workspaceId,
            sourceVariantId,
            status: "pending" as const,
            voiceMode,
            attempt: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ),
      resetForRetry: vi.fn(),
    } as unknown as NonNullable<McpDependencies["reelRenders"]>,
    jobQueue: { enqueue: vi.fn(async () => ({}) as never) } as unknown as NonNullable<
      McpDependencies["jobQueue"]
    >,
    ...overrides,
  }) as unknown as McpDependencies;

const input = { workspaceId, sourceVariantId };

describe("render_reel", () => {
  it("enqueues a render and returns its pending status with the default voice mode", async () => {
    const result = await renderReelTool(input, actorId, dependencies());
    expect(result).toEqual({
      ok: true,
      value: { sourceVariantId, status: "pending", attempt: 1, voiceMode: "script" },
    });
  });

  it("passes voice: none through to requestReelRender", async () => {
    const deps = dependencies();
    const result = await renderReelTool({ ...input, voice: "none" }, actorId, deps);
    expect(deps.reelRenders?.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ voiceMode: "none" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { sourceVariantId, status: "pending", attempt: 1, voiceMode: "none" },
    });
  });

  it("does not queue speech generation for a carousel with detectable slop", async () => {
    const deps = dependencies({
      contentRepository: {
        findVariantForWorkspace: async () => approvedVariant,
        findContentItemForWorkspace: async () => ({
          creativeSlides: [
            { index: 1, total: 5, template: "hero", headline: "Ótima opção", claims: [] },
          ],
        }),
      },
    });
    expect(await renderReelTool(input, actorId, deps)).toEqual({
      ok: false,
      error: "CREATIVE_QUALITY_REJECTED:generic_hook",
    });
    expect(deps.reelRenders?.createPending).not.toHaveBeenCalled();
    expect(deps.jobQueue?.enqueue).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments", async () => {
    const result = await renderReelTool({ workspaceId }, actorId, dependencies());
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const result = await renderReelTool(input, actorId, dependencies({}, "other"));
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("refuses a channel that is not instagram_carousel", async () => {
    const result = await renderReelTool(
      input,
      actorId,
      dependencies({
        channelRepository: {
          findForWorkspace: async () => ({ ...carouselChannel, kind: "threads" }),
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: "CHANNEL_NOT_CAROUSEL" });
  });

  it("refuses an unapproved variant", async () => {
    const result = await renderReelTool(
      input,
      actorId,
      dependencies({
        contentRepository: {
          findVariantForWorkspace: async () => ({ ...approvedVariant, state: "draft" }),
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_APPROVED" });
  });

  it("returns CONTENT_NOT_FOUND for a missing variant", async () => {
    const result = await renderReelTool(
      input,
      actorId,
      dependencies({ contentRepository: { findVariantForWorkspace: async () => null } }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });
});
