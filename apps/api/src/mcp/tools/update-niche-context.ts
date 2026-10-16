import { readExplainerContext } from "@money-maker/core/explainer/explainer-context";
import { silhouetteReport } from "@money-maker/core/explainer/silhouette";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { nicheContextSchema, withContextSizeLimit } from "./editorial-context.js";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const updateNicheContextInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    context: withContextSizeLimit(nicheContextSchema),
  })
  .strict();

export const updateNicheContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = updateNicheContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.nicheRepository) throw new Error("Niche repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const updateContext = deps.nicheRepository.updateContext;
  if (!updateContext) throw new Error("Niche context is not configured.");
  const niche = await updateContext.call(deps.nicheRepository, {
    workspaceId,
    nicheId: parsed.data.nicheId,
    context: parsed.data.context,
  });
  if (!niche) return { ok: false, error: "NOT_FOUND" };
  // v2 slice 19: cast members with a bible are checked in silhouette; advice, never a refusal.
  const cast = (readExplainerContext(niche)?.characters ?? []).filter((c) => c.bible);
  if (cast.length < 2 || !deps.silhouetteMasks) return { ok: true, value: { niche } };
  const report = silhouetteReport(cast, await deps.silhouetteMasks(cast));
  return {
    ok: true,
    value: { niche, silhouetteWarnings: report.warnings, silhouettePairs: report.pairs },
  };
};
