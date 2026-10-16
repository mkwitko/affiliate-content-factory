import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { resolveNicheCaptionTheme } from "@money-maker/core/brand/caption-style";
import { buildNicheResearchContext } from "@money-maker/core/research/niche-context";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getNicheContextInputSchema = z
  .object({ workspaceId: z.uuid(), nicheId: z.string().trim().min(1).max(200) })
  .strict();

export const getNicheContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getNicheContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.nicheRepository) throw new Error("Niche repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;

  const niche = await deps.nicheRepository.findForWorkspace({
    workspaceId,
    nicheId: parsed.data.nicheId,
  });
  if (!niche) return { ok: false, error: "NOT_FOUND" };

  const research = deps.researchRepository;
  const findActiveForNiche = research?.findActiveForNiche;
  const snapshots = findActiveForNiche
    ? await findActiveForNiche.call(research, { workspaceId, nicheId: niche.id, now: new Date() })
    : [];

  return {
    ok: true,
    value: {
      niche: { id: niche.id, context: niche.context ?? null },
      // What the niche's videos actually render with (null: legacy word_pop captions).
      resolvedCaptionTheme: resolveNicheCaptionTheme({ niche, canvas: "portrait" }) ?? null,
      research: buildNicheResearchContext(snapshots),
    },
  };
};
