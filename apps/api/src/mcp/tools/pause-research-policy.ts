import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { pauseResearchPolicy } from "@money-maker/core/research/research-policy";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const pauseResearchPolicyInputSchema = z
  .object({ workspaceId: z.uuid(), nicheId: z.string().trim().min(1).max(200) })
  .strict();

export const pauseResearchPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = pauseResearchPolicyInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.researchPolicyRepository)
    throw new Error("Research policy dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const existing = await deps.researchPolicyRepository.findForNiche({
    workspaceId,
    nicheId: parsed.data.nicheId,
  });
  if (!existing) return { ok: false, error: "NOT_FOUND" };
  const policy = await deps.researchPolicyRepository.update(pauseResearchPolicy(existing));
  return { ok: true, value: { policy } };
};
