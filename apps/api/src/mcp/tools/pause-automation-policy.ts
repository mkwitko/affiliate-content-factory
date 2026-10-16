import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { changePublicationPolicy } from "@money-maker/core/workspaces/publication-policy";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const pauseAutomationPolicyInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const pauseAutomationPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = pauseAutomationPolicyInputSchema.safeParse(args);
  if (!parsed.success || !deps.publicationPolicyRepository)
    return parsed.success
      ? (() => {
          throw new Error("Policy dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  const policy = await deps.publicationPolicyRepository.findForWorkspace(workspaceId);
  return {
    ok: true,
    value: {
      policy: await deps.publicationPolicyRepository.update(
        changePublicationPolicy(policy, "paused"),
      ),
    },
  };
};
