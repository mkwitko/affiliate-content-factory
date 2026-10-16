import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { getLongFormRenderTool } from "./get-long-form-render.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const dependencies = (render: Record<string, unknown>): McpDependencies =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
    },
    longFormRenderRepository: {
      findForWorkspace: async () => render,
    },
  }) as unknown as McpDependencies;

describe("get_long_form_render", () => {
  it("returns timing availability without exposing the manifest payload", async () => {
    const timingManifest = {
      alignmentStatus: "aligned",
      manifestChecksum: "a".repeat(64),
      scriptChecksum: "b".repeat(64),
      words: [{ text: "secret transcript", startMs: 0, endMs: 500 }],
    };
    const render = {
      id: "render-1",
      workspaceId,
      storyboardId: "board-1",
      attempt: 1,
      status: "ready",
      assetId: "asset-1",
      durationMs: 1000,
      wallTimeMs: 2000,
      timingManifest,
      rendererVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await getLongFormRenderTool(
      { workspaceId, renderId: "render-1" },
      actorId,
      dependencies(render),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { hasTimingManifest: true, alignmentStatus: "aligned" },
    });
    expect(JSON.stringify(result)).not.toContain("secret transcript");
    expect(JSON.stringify(result)).not.toContain(timingManifest.manifestChecksum);
    expect(JSON.stringify(result)).not.toContain(timingManifest.scriptChecksum);
  });

  it("summarises the quality report with only the checks that did not pass", async () => {
    const qualityReport = {
      version: 1,
      verdict: "warn",
      checks: [
        { id: "fps", verdict: "pass" },
        { id: "loudness", verdict: "warn", detail: "-18 LUFS" },
        { id: "silence", verdict: "n/a", detail: "audio not required" },
      ],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const result = await getLongFormRenderTool(
      { workspaceId, renderId: "render-1" },
      actorId,
      dependencies({
        id: "render-1",
        workspaceId,
        storyboardId: "board-1",
        attempt: 1,
        status: "ready",
        qualityReport,
        rendererVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        quality: {
          verdict: "warn",
          checks: [{ id: "loudness", verdict: "warn", detail: "-18 LUFS" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("qualityReport");
  });

  it("reports legacy renders without timing as unavailable", async () => {
    const result = await getLongFormRenderTool(
      { workspaceId, renderId: "render-legacy" },
      actorId,
      dependencies({
        id: "render-legacy",
        workspaceId,
        storyboardId: "board-1",
        attempt: 1,
        status: "ready",
        rendererVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    expect(result).toMatchObject({ ok: true, value: { hasTimingManifest: false } });
    expect(result).not.toHaveProperty("value.alignmentStatus");
  });
});
