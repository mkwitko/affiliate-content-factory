import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createChannel, isPublishableChannelKind } from "@money-maker/core/channels/channel";
import type { ChannelKind } from "@money-maker/core/channels/channel";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
const kinds = [
  "instagram_carousel",
  "instagram_stories",
  "instagram_reels",
  "threads",
  "tiktok_photo_post",
  "youtube",
  "tiktok_video",
] as const;
export const createChannelInputSchema = z
  .object({
    workspaceId: z.uuid(),
    connectionId: z.string().trim().min(1).max(200),
    kind: z.enum(kinds),
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const createChannelTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createChannelInputSchema.safeParse(args);
  if (!parsed.success || !deps.channelRepository || !deps.providerConnections)
    return parsed.success
      ? (() => {
          throw new Error("Channel dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  if (
    parsed.data.kind !== "youtube" &&
    !isPublishableChannelKind(parsed.data.kind as ChannelKind)
  ) {
    return { ok: false, error: "CHANNEL_UNSUPPORTED" };
  }
  const connection = await deps.providerConnections.findForWorkspace({
    workspaceId,
    connectionId: parsed.data.connectionId,
  });
  if (!connection) return { ok: false, error: "CONNECTION_NOT_FOUND" };
  if (parsed.data.kind === "youtube" && connection.platform !== "youtube")
    return { ok: false, error: "ACCOUNT_NOT_FOUND" };
  try {
    return {
      ok: true,
      value: {
        channel: await deps.channelRepository.create(
          createChannel({
            workspaceId,
            connection,
            kind: parsed.data.kind as ChannelKind,
            ...(parsed.data.label ? { label: parsed.data.label } : {}),
          }),
        ),
      },
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
