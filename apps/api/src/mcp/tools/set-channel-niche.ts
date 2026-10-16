import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const setChannelNicheInputSchema = z
  .object({
    workspaceId: z.uuid(),
    channelId: z.string().trim().min(1).max(200),
    /** null unbinds the channel; automatic packages then skip it. */
    nicheId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

/** Owner only: which niche profile a channel publishes for. Automatic packages use only these. */
export const setChannelNicheTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = setChannelNicheInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  const setNiche = deps.channelRepository?.setNiche;
  if (!deps.channelRepository || !setNiche || !deps.nicheRepository)
    throw new Error("Channel niche binding is not configured.");
  const { channelId, nicheId } = parsed.data;
  if (nicheId !== null && !(await deps.nicheRepository.findForWorkspace({ workspaceId, nicheId })))
    return { ok: false, error: "NOT_FOUND" };
  const before = await deps.channelRepository.findForWorkspace({ workspaceId, channelId });
  if (!before) return { ok: false, error: "NOT_FOUND" };
  const channel = await setNiche.call(deps.channelRepository, { workspaceId, channelId, nicheId });
  if (!channel) return { ok: false, error: "NOT_FOUND" };
  await deps.audit?.record({
    action: "channel.niche_set",
    workspaceId,
    actorUserId: actorId,
    targetType: "Channel",
    targetId: channelId,
    metadata: { from: before.nicheId ?? "none", to: nicheId ?? "none" },
  });
  return { ok: true, value: { channel } };
};
