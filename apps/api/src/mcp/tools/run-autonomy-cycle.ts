import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { runAutonomyCycle } from "@money-maker/core/autonomy/cycle";
import type { McpDependencies, ToolResult } from "../server.js";
import { autonomyCycleDeps } from "./autonomy-deps.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const runAutonomyCycleInputSchema = z.object({ workspaceId: z.uuid() }).strict();

export const runAutonomyCycleTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = runAutonomyCycleInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const counters = await runAutonomyCycle(autonomyCycleDeps(deps), {
    workspaceId,
    now: new Date(),
  });
  return { ok: true, value: counters };
};
