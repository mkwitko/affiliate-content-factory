import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const getPublicationStatusInputSchema = z
  .object({ workspaceId: z.uuid(), attemptId: z.string().trim().min(1).max(200) })
  .strict();
export const getPublicationStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getPublicationStatusInputSchema.safeParse(args);
  if (!parsed.success || !deps.publicationAttempts)
    return parsed.success
      ? (() => {
          throw new Error("Publication dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const publication = await deps.publicationAttempts.findForWorkspace({
    workspaceId,
    attemptId: parsed.data.attemptId,
  });
  return publication ? { ok: true, value: { publication } } : { ok: false, error: "NOT_FOUND" };
};
