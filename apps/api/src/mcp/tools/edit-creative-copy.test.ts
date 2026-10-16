import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { editCreativeCopyTool } from "./edit-creative-copy.js";

const actorId = parseUserId("11111111-1111-4111-8111-111111111111");
const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const otherWorkspaceId = "55555555-5555-4555-8555-555555555555";
const contentItemId = "33333333-3333-4333-8333-333333333333";
const scene = "44444444-4444-4444-8444-444444444444";
const offer = {
  id: "offer-1",
  workspaceId,
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
} as unknown as Offer;
const item = {
  id: contentItemId,
  workspaceId,
  nicheId: "n",
  offerId: "offer-1",
  offerSnapshotId: "s1",
  title: "t",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
  creativeSlides: Array.from({ length: 5 }, (_, i) => ({
    index: i + 1,
    total: 5,
    template: "benefit",
    headline: `Beneficio ${i + 1}`,
    sceneAssetId: scene,
    claims: [],
  })),
} as unknown as ContentItem;
const variant = {
  id: "v1",
  workspaceId,
  contentItemId,
  channelId: "car",
  assetIds: ["a"],
  caption: "x #publi",
  state: "draft",
  voiceScript: [],
} as unknown as ContentVariant;

const dependencies = (role: "operator" | "viewer" | null = "operator") => {
  const contentRepository = {
    findContentItemForWorkspace: vi.fn(async (input: { workspaceId: string }) =>
      input.workspaceId === workspaceId ? item : null,
    ),
    updateContentItem: vi.fn(async (v: ContentItem) => v),
    listVariantsForWorkspace: vi.fn(async () => [variant]),
    updateVariant: vi.fn(async (v: ContentVariant) => v),
  };
  const jobQueue = { enqueue: vi.fn(async () => ({ id: "job" })) };
  const deps = {
    authenticate: async () => ({ userId: actorId }),
    workspaces: {
      findMembership: async () =>
        role ? { workspaceId, userId: actorId, role, status: "active" as const } : null,
    },
    contentRepository,
    offerRepository: { findForWorkspace: async () => offer },
    channelRepository: {
      findForWorkspace: async () => ({
        id: "car",
        workspaceId,
        kind: "instagram_carousel",
        capabilities: { captionMaxLength: 2200 },
      }),
    },
    jobQueue,
  } as unknown as McpDependencies;
  return { deps, contentRepository, jobQueue };
};

describe("edit_creative_copy MCP tool", () => {
  it("saves the edit, queues the re-render and returns the updated text", async () => {
    const { deps, contentRepository, jobQueue } = dependencies();
    const result = await editCreativeCopyTool(
      { workspaceId, contentItemId, slides: [{ index: 2, headline: "Novo titulo" }] },
      actorId,
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        rerenderQueued: true,
        slides: expect.arrayContaining([
          expect.objectContaining({ index: 2, headline: "Novo titulo" }),
        ]),
      },
    });
    expect(contentRepository.updateContentItem).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeSlides: expect.arrayContaining([
          expect.objectContaining({ headline: "Novo titulo", sceneAssetId: scene }),
        ]),
      }),
    );
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("denies a non-member, rejects bad input and cannot reach another workspace's item", async () => {
    const denied = dependencies(null);
    expect(
      await editCreativeCopyTool(
        { workspaceId, contentItemId, slides: [{ index: 1, headline: "x" }] },
        actorId,
        denied.deps,
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
    const { deps, contentRepository } = dependencies();
    expect(await editCreativeCopyTool({ workspaceId, contentItemId }, actorId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    expect(
      await editCreativeCopyTool(
        { workspaceId: otherWorkspaceId, contentItemId, slides: [{ index: 1, headline: "x" }] },
        actorId,
        deps,
      ),
    ).toMatchObject({ ok: false });
    expect(contentRepository.updateContentItem).not.toHaveBeenCalled();
  });
});
