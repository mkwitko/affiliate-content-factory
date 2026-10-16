import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { brandContextSchema, withContextSizeLimit } from "./editorial-context.js";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const updateBrandContextInputSchema = z
  .object({ workspaceId: z.uuid(), context: withContextSizeLimit(brandContextSchema) })
  .strict();

export const updateBrandContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = updateBrandContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const updateContext = deps.workspaces.updateContext;
  if (!updateContext) throw new Error("Workspace context is not configured.");
  await updateContext.call(deps.workspaces, { workspaceId, context: parsed.data.context });
  return { ok: true, value: { context: parsed.data.context } };
};
