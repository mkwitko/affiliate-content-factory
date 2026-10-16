import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { changePublicationPolicy } from "@money-maker/core/workspaces/publication-policy";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const createAutomationPolicyInputSchema = z
  .object({
    workspaceId: z.uuid(),
    maxPublicationsPerPeriod: z.number().int().positive().max(10000),
    maxCostMinorPerItem: z.number().int().nonnegative().max(100000000),
    maxCostMinorPerPeriod: z.number().int().nonnegative().max(1000000000),
    periodHours: z.number().int().min(1).max(720),
    evidenceMaxAgeDays: z.number().int().min(1).max(30).optional(),
  })
  .strict();
export const createAutomationPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createAutomationPolicyInputSchema.safeParse(args);
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
  const current = await deps.publicationPolicyRepository.findForWorkspace(workspaceId);
  const limits = {
    maxPublicationsPerPeriod: parsed.data.maxPublicationsPerPeriod,
    maxCostMinorPerItem: parsed.data.maxCostMinorPerItem,
    maxCostMinorPerPeriod: parsed.data.maxCostMinorPerPeriod,
    periodHours: parsed.data.periodHours,
    ...(parsed.data.evidenceMaxAgeDays === undefined
      ? {}
      : { evidenceMaxAgeDays: parsed.data.evidenceMaxAgeDays }),
  };
  const policy = changePublicationPolicy(current, "policy_based", limits);
  return { ok: true, value: { policy: await deps.publicationPolicyRepository.update(policy) } };
};
