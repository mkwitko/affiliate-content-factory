import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const getAutomationPolicyInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const getAutomationPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getAutomationPolicyInputSchema.safeParse(args);
  if (!parsed.success || !deps.publicationPolicyRepository)
    return parsed.success
      ? (() => {
          throw new Error("Policy dependencies are not configured.");
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
  return {
    ok: true,
    value: { policy: await deps.publicationPolicyRepository.findForWorkspace(workspaceId) },
  };
};
