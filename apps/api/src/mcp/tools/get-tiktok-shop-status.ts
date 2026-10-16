import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  accountStrategyFor,
  effectiveShopState,
  parseTikTokShopStatus,
  shopTrackFor,
} from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getTikTokShopStatusInputSchema = z
  .object({ workspaceId: z.uuid(), channelId: z.string().trim().min(1).max(200) })
  .strict();

const inAppPath = "Perfil → menu → TikTok Studio → TikTok Shop para criadores";

const messageFor = (effectiveState: string): string =>
  effectiveState === "unknown"
    ? "TikTok Shop status: UNKNOWN — automatic verification unavailable"
    : `TikTok Shop status: ${effectiveState.toUpperCase().replaceAll("_", " ")}`;

export const getTikTokShopStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getTikTokShopStatusInputSchema.safeParse(args);
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
  if (channel.kind !== "tiktok_video") return { ok: false, error: "CHANNEL_NOT_TIKTOK" };

  const now = new Date();
  const status = parseTikTokShopStatus(channel.context);
  const effectiveState = effectiveShopState(status, now);
  const stale = status !== null && effectiveState === "unknown" && status.state !== "unknown";

  return {
    ok: true,
    value: {
      state: status?.state ?? "unknown",
      effectiveState,
      stale,
      observedAt: status?.observedAt ?? null,
      reason: status?.reason ?? null,
      bioLinkAvailable: status?.bioLinkAvailable ?? null,
      track: shopTrackFor(effectiveState, status?.reason),
      strategy: accountStrategyFor(status, now),
      inAppPath,
      message: messageFor(effectiveState),
    },
  };
};
