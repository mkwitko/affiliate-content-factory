import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { requestLongFormRender } from "@money-maker/core/publishing/long-form-render";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const renderLongFormInputSchema = z
  .object({ workspaceId: z.uuid(), storyboardId: z.string().min(1).max(200) })
  .strict();
export const renderLongFormTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = renderLongFormInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.storyboardRepository ||
    !deps.longFormRenderRepository ||
    !deps.jobQueue
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.longFormAvailable) return { ok: false, error: "VOICE_SCRIPT_UNSUPPORTED" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const storyboard = await deps.storyboardRepository.findForWorkspace({
    workspaceId,
    storyboardId: parsed.data.storyboardId,
  });
  if (!storyboard) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const result = await requestLongFormRender({
    workspaceId,
    storyboard,
    renderId: randomUUID(),
    rendererVersion: 1,
    renders: deps.longFormRenderRepository,
    jobs: deps.jobQueue,
  });
  return {
    ok: true,
    value: {
      renderId: result.render.id,
      attempt: result.render.attempt,
      status: result.render.status,
    },
  };
};
