import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createResearchPolicy } from "@money-maker/core/research/research-policy";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const createResearchPolicyInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    frequency: z.enum(["daily", "weekly"]),
    maxCandidatesPerRun: z.number().int().min(1).max(20),
    priceMinMinor: z.number().int().nonnegative().optional(),
    priceMaxMinor: z.number().int().nonnegative().optional(),
    currency: z.string().trim().min(1).max(10).optional(),
    targetPendingLinks: z.number().int().min(0).max(20).optional(),
    queries: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

export const createResearchPolicyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createResearchPolicyInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.nicheRepository || !deps.researchPolicyRepository)
    throw new Error("Research policy dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const niche = await deps.nicheRepository.findForWorkspace({
    workspaceId,
    nicheId: parsed.data.nicheId,
  });
  if (!niche) return { ok: false, error: "INVALID_ARGUMENTS" };
  try {
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: parsed.data.nicheId,
      frequency: parsed.data.frequency,
      maxCandidatesPerRun: parsed.data.maxCandidatesPerRun,
      ...(parsed.data.priceMinMinor === undefined
        ? {}
        : { priceMinMinor: parsed.data.priceMinMinor }),
      ...(parsed.data.priceMaxMinor === undefined
        ? {}
        : { priceMaxMinor: parsed.data.priceMaxMinor }),
      ...(parsed.data.currency === undefined ? {} : { currency: parsed.data.currency }),
      ...(parsed.data.targetPendingLinks === undefined
        ? {}
        : { targetPendingLinks: parsed.data.targetPendingLinks }),
      ...(parsed.data.queries === undefined ? {} : { explicitQueries: parsed.data.queries }),
    });
    return { ok: true, value: { policy: await deps.researchPolicyRepository.create(policy) } };
  } catch {
    return { ok: false, error: "INVALID_ARGUMENTS" };
  }
};
