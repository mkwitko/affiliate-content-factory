import type { UserId } from "@money-maker/contracts";
import { qualitySummary } from "@money-maker/core/publishing/render-quality";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getLongFormRenderInputSchema = z
  .object({ workspaceId: z.uuid(), renderId: z.string().min(1).max(200) })
  .strict();
export const getLongFormRenderTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getLongFormRenderInputSchema.safeParse(args);
  if (!parsed.success || !deps.longFormRenderRepository)
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const render = await deps.longFormRenderRepository.findForWorkspace({
    workspaceId,
    renderId: parsed.data.renderId,
  });
  if (!render) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const previewUrl =
    render.assetId && deps.assetStore
      ? ((
          await deps.assetStore
            .createDownload({ workspaceId, assetId: render.assetId })
            .catch(() => null)
        )?.url ?? null)
      : null;
  const { timingManifest, qualityReport, ...summary } = render;
  return {
    ok: true,
    value: {
      ...summary,
      hasTimingManifest: timingManifest !== undefined,
      ...(timingManifest ? { alignmentStatus: timingManifest.alignmentStatus } : {}),
      ...(qualityReport ? { quality: qualitySummary(qualityReport) } : {}),
      previewUrl,
    },
  };
};
