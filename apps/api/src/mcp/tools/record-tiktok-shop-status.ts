import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  accountStrategyFor,
  parseTikTokShopStatus,
  recordTikTokShopStatus,
} from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const shopStates = [
  "unknown",
  "not_connected",
  "not_eligible",
  "eligible_not_onboarded",
  "onboarding",
  "shop_enabled",
  "restricted",
  "suspended",
] as const;
const shopReasons = [
  "followers",
  "age",
  "region",
  "account_type",
  "identity",
  "policy",
  "unknown",
] as const;

export const recordTikTokShopStatusInputSchema = z
  .object({
    workspaceId: z.uuid(),
    channelId: z.string().trim().min(1).max(200),
    state: z.enum(shopStates),
    reason: z.enum(shopReasons).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    bioLinkAvailable: z
      .boolean()
      .optional()
      .describe("True only if the operator confirmed the TikTok profile can show a website link."),
  })
  .strict()
  .describe(
    "Record what the operator observed in the TikTok app checklist (Perfil → menu → TikTok Studio → TikTok Shop para criadores). Never guess this; only record what the operator actually read in-app.",
  );

export const recordTikTokShopStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordTikTokShopStatusInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.channelRepository || !deps.audit)
    throw new Error("TikTok Shop status dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const updateContext = deps.channelRepository.updateContext;
  if (!updateContext) throw new Error("Channel context is not configured.");
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: parsed.data.channelId,
  });
  if (!channel) return { ok: false, error: "NOT_FOUND" };
  if (channel.kind !== "tiktok_video") return { ok: false, error: "CHANNEL_NOT_TIKTOK" };

  const previous = parseTikTokShopStatus(channel.context);
  const now = new Date();
  let status: ReturnType<typeof recordTikTokShopStatus>;
  try {
    status = recordTikTokShopStatus(
      previous,
      {
        state: parsed.data.state,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        ...(parsed.data.bioLinkAvailable === undefined
          ? {}
          : { bioLinkAvailable: parsed.data.bioLinkAvailable }),
      },
      now,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "shop_status_note_sensitive") {
      return { ok: false, error: "SHOP_STATUS_NOTE_SENSITIVE" };
    }
    if (error instanceof Error) return { ok: false, error: "INVALID_ARGUMENTS" };
    throw error;
  }

  const updated = await updateContext.call(deps.channelRepository, {
    workspaceId,
    channelId: channel.id,
    context: { ...(channel.context ?? {}), tiktokShop: status },
  });
  if (!updated) return { ok: false, error: "NOT_FOUND" };

  // Never the note: it is free text that may repeat the operator's raw checklist wording.
  await deps.audit.record({
    action: "channel.tiktok_shop_status_recorded",
    workspaceId,
    actorUserId: actorId,
    targetType: "Channel",
    targetId: channel.id,
    metadata: {
      state: status.state,
      ...(status.reason ? { reason: status.reason } : {}),
    },
  });

  return { ok: true, value: { status, strategy: accountStrategyFor(status, now) } };
};
