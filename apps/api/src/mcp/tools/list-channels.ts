import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { isPublishableChannelKind } from "@money-maker/core/channels/channel";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument, requireList } from "./workspace-access.js";
export const listChannelsInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const listChannelsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listChannelsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const channels = await requireList(deps.channelRepository)(workspaceId);
  return {
    ok: true,
    value: {
      channels: channels.map((channel) => ({
        ...channel,
        publishable: isPublishableChannelKind(channel.kind),
      })),
    },
  };
};
