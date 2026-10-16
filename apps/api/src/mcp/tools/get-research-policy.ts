import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getResearchPolicyInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const getResearchPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getResearchPolicyInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.researchPolicyRepository)
    throw new Error("Research policy dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (parsed.data.nicheId) {
    const policy = await deps.researchPolicyRepository.findForNiche({
      workspaceId,
      nicheId: parsed.data.nicheId,
    });
    return { ok: true, value: { policy } };
  }
  return {
    ok: true,
    value: { policies: await deps.researchPolicyRepository.listForWorkspace(workspaceId) },
  };
};
