import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { channelContextSchema, withContextSizeLimit } from "./editorial-context.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const updateChannelContextInputSchema = z
  .object({
    workspaceId: z.uuid(),
    channelId: z.string().trim().min(1).max(200),
    context: withContextSizeLimit(channelContextSchema),
  })
  .strict();

export const updateChannelContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = updateChannelContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.channelRepository) throw new Error("Channel repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const updateContext = deps.channelRepository.updateContext;
  if (!updateContext) throw new Error("Channel context is not configured.");
  // This tool replaces the whole editorial context (channelContextSchema is strict, so a client
  // can never set tiktokShop here); only record_tiktok_shop_status may write that key, so carry it
  // forward instead of dropping it.
  const existing = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: parsed.data.channelId,
  });
  if (!existing) return { ok: false, error: "NOT_FOUND" };
  const existingTikTokShop = (existing.context as Record<string, unknown> | null | undefined)
    ?.tiktokShop;
  const context = {
    ...parsed.data.context,
    ...(existingTikTokShop !== undefined ? { tiktokShop: existingTikTokShop } : {}),
  };
  const channel = await updateContext.call(deps.channelRepository, {
    workspaceId,
    channelId: parsed.data.channelId,
    context,
  });
  if (!channel) return { ok: false, error: "NOT_FOUND" };
  return { ok: true, value: { channel } };
};
