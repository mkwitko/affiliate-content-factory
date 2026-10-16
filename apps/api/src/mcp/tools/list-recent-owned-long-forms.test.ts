import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { listRecentOwnedLongFormsTool } from "./list-recent-owned-long-forms.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const recent = [
  {
    render: {
      id: "render-new",
      workspaceId,
      storyboardId: "story-new",
      attempt: 1,
      status: "ready" as const,
      assetId: "asset-new",
      durationMs: 60_000,
      timingManifest: { manifestChecksum: "a".repeat(64) },
      rendererVersion: 1,
      createdAt: new Date("2026-09-28T12:00:00.000Z"),
      updatedAt: new Date("2026-09-28T12:00:00.000Z"),
    },
    contentItemId: "item-new",
    contentTitle: "The newer video",
  },
  {
    render: {
      id: "render-old",
      workspaceId,
      storyboardId: "story-old",
      attempt: 1,
      status: "ready" as const,
      assetId: "asset-old",
      durationMs: 120_000,
      rendererVersion: 1,
      createdAt: new Date("2026-09-27T12:00:00.000Z"),
      updatedAt: new Date("2026-09-27T12:00:00.000Z"),
    },
    contentItemId: "item-old",
    contentTitle: "The older video",
  },
];

const dependencies = (options?: { canRead?: boolean }) => {
  const listRecentForWorkspace = vi.fn(async () => recent);
  const deps = {
    workspaces: {
      findMembership: async () =>
        options?.canRead === false
          ? null
          : { workspaceId, userId, role: "operator", status: "active" },
    },
    longFormRenderRepository: { listRecentForWorkspace },
    assetRepository: {
      findForWorkspace: async ({ assetId }: { assetId: string }) => ({
        id: assetId,
        metadata: assetId === "asset-new" ? { ownedClipCandidates: { candidates: [{}, {}] } } : {},
      }),
    },
  } as unknown as McpDependencies;
  return { deps, listRecentForWorkspace };
};

describe("list_recent_owned_long_forms", () => {
  it("lists recent workspace renders with display labels and timing availability", async () => {
    const { deps, listRecentForWorkspace } = dependencies();
    const result = await listRecentOwnedLongFormsTool({ workspaceId }, userId, deps);

    expect(listRecentForWorkspace).toHaveBeenCalledWith({ workspaceId, limit: 5 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        renders: [
          {
            renderId: "render-new",
            contentItemId: "item-new",
            title: "The newer video",
            status: "ready",
            timingAvailable: true,
            candidateCount: 2,
          },
          {
            renderId: "render-old",
            contentItemId: "item-old",
            title: "The older video",
            status: "ready",
            timingAvailable: false,
            candidateCount: 0,
          },
        ],
      },
    });
  });

  it("rejects invalid bounds and denies a non-member", async () => {
    const { deps, listRecentForWorkspace } = dependencies();
    await expect(
      listRecentOwnedLongFormsTool({ workspaceId, limit: 11 }, userId, deps),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(listRecentForWorkspace).not.toHaveBeenCalled();

    const denied = dependencies({ canRead: false });
    await expect(
      listRecentOwnedLongFormsTool({ workspaceId }, userId, denied.deps),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
    expect(denied.listRecentForWorkspace).not.toHaveBeenCalled();
  });

  it("returns an empty list without inventing a recent source", async () => {
    const empty = dependencies();
    empty.listRecentForWorkspace.mockResolvedValue([]);
    await expect(
      listRecentOwnedLongFormsTool({ workspaceId, limit: 2 }, userId, empty.deps),
    ).resolves.toEqual({ ok: true, value: { renders: [] } });
    expect(empty.listRecentForWorkspace).toHaveBeenCalledWith({ workspaceId, limit: 2 });
  });
});
