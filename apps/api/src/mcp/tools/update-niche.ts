import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const updateNicheInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
    audience: z.string().trim().min(1).max(1000).optional(),
    problem: z.string().trim().min(1).max(1000).optional(),
    editorialVoice: z.string().trim().min(1).max(1000).optional(),
    languages: z
      .array(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/))
      .min(1)
      .max(20)
      .optional(),
    monetizationHypothesis: z.string().trim().min(1).max(1000).optional(),
    /** Owner only: `active` lets research, the autonomy cycle and scene jobs use the niche. */
    state: z.enum(["draft", "active", "archived"]).optional(),
  })
  .strict();

export const updateNicheTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = updateNicheInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.nicheRepository) throw new Error("Niche repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const update = deps.nicheRepository.update;
  if (!update) throw new Error("Niche update is not configured.");
  const {
    nicheId,
    name,
    audience,
    problem,
    editorialVoice,
    languages,
    monetizationHypothesis,
    state,
  } = parsed.data;
  if (state !== undefined) {
    const notOwner = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
    if (notOwner) return notOwner;
    const before = await deps.nicheRepository.findForWorkspace({ workspaceId, nicheId });
    if (!before) return { ok: false, error: "NOT_FOUND" };
    if (before.state !== state) {
      await deps.nicheRepository.updateState({ workspaceId, nicheId, state });
      await deps.audit?.record({
        action: "niche.state_changed",
        workspaceId,
        actorUserId: actorId,
        targetType: "Niche",
        targetId: nicheId,
        metadata: { from: before.state, to: state },
      });
    }
  }
  const niche = await update.call(deps.nicheRepository, {
    workspaceId,
    nicheId,
    ...(name !== undefined ? { name } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(problem !== undefined ? { problem } : {}),
    ...(editorialVoice !== undefined ? { editorialVoice } : {}),
    ...(languages !== undefined ? { languages } : {}),
    ...(monetizationHypothesis !== undefined ? { monetizationHypothesis } : {}),
  });
  if (!niche) return { ok: false, error: "NOT_FOUND" };
  return { ok: true, value: { niche } };
};
