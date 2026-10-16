import { createCreativeBrief } from "@money-maker/core/creatives/creative-brief";
import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
import { buildOpportunityBriefTool } from "./build-opportunity-brief.js";

export const createCreativeBriefInputSchema = z
  .object({
    workspaceId: z.uuid(),
    offerId: z.string().trim().min(1).max(200),
    channelId: z.string().trim().min(1).max(200),
    audience: z.string().trim().min(1).max(200),
  })
  .strict();

export const createCreativeBriefTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createCreativeBriefInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.channelRepository) return { ok: false, error: "CONNECTION_UNAVAILABLE" };

  try {
    const opportunity = await buildOpportunityBriefTool(
      { workspaceId, offerId: parsed.data.offerId },
      actorId,
      deps,
    );
    if (!opportunity.ok) return opportunity;
    const channel = await deps.channelRepository.findForWorkspace({
      workspaceId,
      channelId: parsed.data.channelId,
    });
    if (!channel || channel.status !== "active") return { ok: false, error: "NOT_FOUND" };
    const briefData = opportunity.value as {
      offer: Parameters<typeof createCreativeBrief>[0]["offer"];
      signals: { buyerVoice: Parameters<typeof createCreativeBrief>[0]["buyerVoice"] };
    };
    return {
      ok: true,
      value: {
        ...createCreativeBrief({
          offer: briefData.offer,
          channelKind: channel.kind,
          audience: parsed.data.audience,
          buyerVoice: briefData.signals.buyerVoice,
        }),
        opportunityReadiness: "incomplete",
        requiresHumanReview: true,
      },
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
