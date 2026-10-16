import type { UserId } from "@money-maker/contracts";
import { createDirectScenesJob } from "@money-maker/core/content/direct-scenes";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const requestSceneDirectionInputSchema = z
  .object({ workspaceId: z.uuid(), scriptId: z.string().min(1).max(200) })
  .strict();

/**
 * Queues a local-director storyboard draft for an approved script (v2 slice 26). Registered only
 * when SCENE_DIRECTION_ENABLED is set; a `local_ai` worker with a verified director model claims
 * the job and stores the next storyboard version. It never renders or publishes: review it and
 * call render_long_form as with any storyboard.
 */
export const requestSceneDirectionTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = requestSceneDirectionInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.sceneDirectionAvailable ||
    !deps.jobQueue ||
    !deps.editorialRepository
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const script = await deps.editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: parsed.data.scriptId,
  });
  if (!script) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (script.status !== "approved") return { ok: false, error: "SCRIPT_NOT_APPROVED" };
  const job = await deps.jobQueue.enqueue(
    createDirectScenesJob({ workspaceId, scriptId: script.id }),
  );
  return { ok: true, value: { jobId: job.id, scriptId: script.id, status: "queued" } };
};
