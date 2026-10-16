import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { describe, expect, it } from "vitest";
import {
  getLongFormTimingTool,
  refineOwnedClipBoundariesTool,
  refineOwnedClipTimeRangeTool,
} from "./owned-clip-timing.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const manifest = buildRenderTimingManifest({
  workspaceId,
  renderId: "render-1",
  storyboardId: "board-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: "script-1",
  scriptChecksum: "b".repeat(64),
  scriptLength: 22,
  renderedAssetId: "video-1",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 10_000,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-26T12:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 22,
      startMs: 0,
      endMs: 10_000,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "d".repeat(64),
    },
  ],
  words: [{ text: "answer", fromChar: 12, toChar: 18, startMs: 1900, endMs: 2400, sceneIndex: 1 }],
});

const dependencies = (
  render: Record<string, unknown> = {
    id: "render-1",
    workspaceId,
    status: "ready",
    timingManifest: manifest,
  },
  role: "owner" | "reviewer" | "other" = "owner",
): McpDependencies =>
  ({
    workspaces: {
      findMembership: async () =>
        role === "other" ? null : { workspaceId, userId: actorId, role, status: "active" },
    },
    longFormRenderRepository: {
      findForWorkspace: async ({ workspaceId: requested }: { workspaceId: string }) =>
        requested === workspaceId ? render : null,
    },
  }) as unknown as McpDependencies;

describe("owned clip timing tools", () => {
  it("returns timed source words only through the explicit workspace-scoped timing tool", async () => {
    const result = await getLongFormTimingTool(
      { workspaceId, renderId: "render-1" },
      actorId,
      dependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        scriptId: "script-1",
        scriptChecksum: "b".repeat(64),
        alignmentStatus: "aligned",
        words: [{ text: "answer", fromChar: 12, startMs: 1900 }],
      },
    });
  });

  it("refines a semantic character span to safe word and speech-gap boundaries", async () => {
    const result = await refineOwnedClipBoundariesTool(
      { workspaceId, renderId: "render-1", fromChar: 12, toChar: 18 },
      actorId,
      dependencies(),
    );
    expect(result).toMatchObject({ ok: true, value: { startMs: 1900, endMs: 2400 } });
  });

  it("refines an operator timestamp range through the same bound timing manifest", async () => {
    const result = await refineOwnedClipTimeRangeTool(
      { workspaceId, renderId: "render-1", startMs: 1800, endMs: 2500 },
      actorId,
      dependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        requestedStartMs: 1800,
        requestedEndMs: 2500,
        startMs: 1900,
        endMs: 2400,
        fromChar: 12,
        toChar: 18,
      },
    });
  });

  it("returns an explicit error for a time range outside the rendered duration", async () => {
    const result = await refineOwnedClipTimeRangeTool(
      { workspaceId, renderId: "render-1", startMs: 10_000, endMs: 11_000 },
      actorId,
      dependencies(),
    );
    expect(result).toEqual({ ok: false, error: "CLIP_TIME_RANGE_INVALID" });
  });

  it("refuses legacy or non-ready renders and denies cross-workspace members", async () => {
    await expect(
      getLongFormTimingTool(
        { workspaceId, renderId: "render-1" },
        actorId,
        dependencies({ id: "render-1", workspaceId, status: "ready" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "CLIP_TIMING_UNAVAILABLE" });
    await expect(
      getLongFormTimingTool(
        { workspaceId, renderId: "render-1" },
        actorId,
        dependencies(undefined, "other"),
      ),
    ).resolves.toMatchObject({ ok: false, error: "FORBIDDEN" });
  });
});
