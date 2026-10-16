import type { UserId } from "@money-maker/contracts";
import { qualitySummary } from "@money-maker/core/publishing/render-quality";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getReelRenderInputSchema = z
  .object({ workspaceId: z.uuid(), sourceVariantId: z.string().trim().min(1).max(200) })
  .strict()
  .describe(
    "Read one Reel render's status after render_reel: pending, ready (with the video assetId, a short-lived previewUrl, and musicTrack: the background track id <niche>/<mood>/<file>, or null when silent), or failed (with a reason).",
  );

export const getReelRenderTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getReelRenderInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.reelRenders) throw new Error("Reel render dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const render = await deps.reelRenders.findForWorkspace({
    workspaceId,
    sourceVariantId: parsed.data.sourceVariantId,
  });
  if (!render) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (render.status !== "ready" || !render.assetId) {
    return {
      ok: true,
      value: {
        sourceVariantId: parsed.data.sourceVariantId,
        status: render.status,
        ...(render.reason ? { reason: render.reason } : {}),
        ...(render.qualityReport ? { quality: qualitySummary(render.qualityReport) } : {}),
      },
    };
  }
  if (!deps.assetStore) throw new Error("Reel render dependencies are not configured.");
  const target = await deps.assetStore.createDownload({
    workspaceId,
    assetId: render.assetId,
  });
  return {
    ok: true,
    value: {
      sourceVariantId: parsed.data.sourceVariantId,
      status: "ready",
      assetId: render.assetId,
      previewUrl: target.url,
      musicTrack: render.musicTrackId ?? null,
      voice: { mode: render.voiceMode, voiceId: render.voiceId ?? null },
      durationMs: render.durationMs ?? null,
      ...(render.qualityReport ? { quality: qualitySummary(render.qualityReport) } : {}),
    },
  };
};
