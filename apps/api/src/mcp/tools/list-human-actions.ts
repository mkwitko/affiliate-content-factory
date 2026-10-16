import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { listHumanActions } from "@money-maker/core/autonomy/human-actions";
import type { McpDependencies, ToolResult } from "../server.js";
import { humanActionDeps } from "./autonomy-deps.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const listHumanActionsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

export const listHumanActionsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listHumanActionsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const actions = await listHumanActions(humanActionDeps(deps), {
    workspaceId,
    limit: parsed.data.limit,
  });
  return { ok: true, value: { actions } };
};
