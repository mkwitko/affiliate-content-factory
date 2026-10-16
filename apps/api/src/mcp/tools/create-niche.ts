import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createNiche } from "@money-maker/core/niches/niche";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const createNicheInputSchema = z
  .object({
    workspaceId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    audience: z.string().trim().min(1).max(1000),
    problem: z.string().trim().min(1).max(1000),
    editorialVoice: z.string().trim().min(1).max(1000),
    languages: z
      .array(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/))
      .min(1)
      .max(20),
    monetizationHypothesis: z.string().trim().min(1).max(1000),
    // media: audience-first editorial brand (stickman explainers); fixed at creation.
    kind: z.enum(["affiliate", "media"]).optional(),
  })
  .strict();
export const createNicheTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createNicheInputSchema.safeParse(args);
  if (!parsed.success || !deps.nicheRepository)
    return parsed.success
      ? (() => {
          throw new Error("Niche repository is not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  return {
    ok: true,
    value: {
      niche: await deps.nicheRepository.create(createNiche({ ...parsed.data, workspaceId })),
    },
  };
};
