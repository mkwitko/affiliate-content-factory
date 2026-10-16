import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getChannelContextInputSchema = z
  .object({ workspaceId: z.uuid(), channelId: z.string().trim().min(1).max(200) })
  .strict();

export const getChannelContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getChannelContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.channelRepository) throw new Error("Channel repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: parsed.data.channelId,
  });
  if (!channel) return { ok: false, error: "NOT_FOUND" };
  return { ok: true, value: { context: channel.context ?? null } };
};
