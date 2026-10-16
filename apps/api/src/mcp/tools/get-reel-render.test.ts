import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { getReelRenderTool } from "./get-reel-render.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const sourceVariantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    reelRenders: {
      findForWorkspace: async () => ({
        id: "render-1",
        workspaceId,
        sourceVariantId,
        status: "ready" as const,
        assetId: "asset-1",
        voiceMode: "script" as const,
        voiceId: "pf_dora",
        durationMs: 21_400,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      resetForRetry: vi.fn(),
    } as unknown as NonNullable<McpDependencies["reelRenders"]>,
    assetStore: {
      createDownload: async ({ assetId }: { assetId: string }) => ({
        method: "GET" as const,
        url: `https://r2.example/${assetId}?sig=1`,
      }),
    } as unknown as NonNullable<McpDependencies["assetStore"]>,
    ...overrides,
  }) as unknown as McpDependencies;

const input = { workspaceId, sourceVariantId };

describe("get_reel_render", () => {
  it("returns the asset id, a preview URL, and the voice and duration when ready", async () => {
    const result = await getReelRenderTool(input, actorId, dependencies());
    expect(result).toEqual({
      ok: true,
      value: {
        sourceVariantId,
        status: "ready",
        assetId: "asset-1",
        previewUrl: "https://r2.example/asset-1?sig=1",
        musicTrack: null,
        voice: { mode: "script", voiceId: "pf_dora" },
        durationMs: 21_400,
      },
    });
  });

  it("returns a null voiceId and durationMs for a ready render without voice", async () => {
    const result = await getReelRenderTool(
      input,
      actorId,
      dependencies({
        reelRenders: {
          findForWorkspace: async () => ({
            id: "render-1",
            workspaceId,
            sourceVariantId,
            status: "ready" as const,
            assetId: "asset-1",
            voiceMode: "none" as const,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          resetForRetry: vi.fn(),
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        sourceVariantId,
        status: "ready",
        assetId: "asset-1",
        previewUrl: "https://r2.example/asset-1?sig=1",
        musicTrack: null,
        voice: { mode: "none", voiceId: null },
        durationMs: null,
      },
    });
  });

  it("returns pending status without touching the asset store", async () => {
    const result = await getReelRenderTool(
      input,
      actorId,
      dependencies({
        reelRenders: {
          findForWorkspace: async () => ({
            id: "render-1",
            workspaceId,
            sourceVariantId,
            status: "pending" as const,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      }),
    );
    expect(result).toEqual({ ok: true, value: { sourceVariantId, status: "pending" } });
  });

  it("returns failed status with the reason", async () => {
    const result = await getReelRenderTool(
      input,
      actorId,
      dependencies({
        reelRenders: {
          findForWorkspace: async () => ({
            id: "render-1",
            workspaceId,
            sourceVariantId,
            status: "failed" as const,
            reason: "asset_unavailable",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { sourceVariantId, status: "failed", reason: "asset_unavailable" },
    });
  });

  it("returns the blocking quality checks of a failed render", async () => {
    const result = await getReelRenderTool(
      input,
      actorId,
      dependencies({
        reelRenders: {
          findForWorkspace: async () => ({
            id: "render-1",
            workspaceId,
            sourceVariantId,
            status: "failed" as const,
            reason: "quality_blocked:black",
            qualityReport: {
              version: 1 as const,
              verdict: "block" as const,
              checks: [
                { id: "fps" as const, verdict: "pass" as const },
                { id: "black" as const, verdict: "block" as const, detail: "longest 2s" },
              ],
              measuredAt: "2026-10-01T00:00:00.000Z",
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        sourceVariantId,
        status: "failed",
        reason: "quality_blocked:black",
        quality: {
          verdict: "block",
          checks: [{ id: "black", verdict: "block", detail: "longest 2s" }],
        },
      },
    });
  });

  it("returns CONTENT_NOT_FOUND when no render exists", async () => {
    const result = await getReelRenderTool(
      input,
      actorId,
      dependencies({ reelRenders: { findForWorkspace: async () => null } }),
    );
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });

  it("rejects invalid arguments", async () => {
    const result = await getReelRenderTool({ workspaceId }, actorId, dependencies());
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const result = await getReelRenderTool(input, actorId, dependencies({}, "other"));
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
