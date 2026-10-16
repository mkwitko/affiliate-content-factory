import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { getAutonomyStatus } from "@money-maker/core/autonomy/status";
import type { McpDependencies, ToolResult } from "../server.js";
import { statusDeps } from "./autonomy-deps.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getAutonomyStatusInputSchema = z.object({ workspaceId: z.uuid() }).strict();

export const getAutonomyStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getAutonomyStatusInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  return {
    ok: true,
    value: await getAutonomyStatus(statusDeps(deps), {
      workspaceId,
      now: new Date(),
    }),
  };
};
