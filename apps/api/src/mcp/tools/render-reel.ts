import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { requestReelRender } from "@money-maker/core/publishing/reel-render";
import { validateSlideDeckQuality } from "@money-maker/core/creatives/slide-spec";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const renderReelInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceVariantId: z.string().trim().min(1).max(200),
    voice: z
      .enum(["script", "none"])
      .default("script")
      .describe(
        "script (default) narrates the variant's voiceScript; none renders music only. Use none only after the operator chose it on a voice_failed render.",
      ),
  })
  .strict()
  .describe(
    "Render an Instagram Reel from an approved or published instagram_carousel variant's own slides (no AI video). Idempotent per sourceVariantId: a repeat call returns the same render's status instead of rendering twice. A failed render, or a pending one stuck for more than 15 minutes, is retried by calling again. Poll get_reel_render for the result.",
  );

export const renderReelTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = renderReelInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.channelRepository || !deps.reelRenders || !deps.jobQueue) {
    throw new Error("Reel render dependencies are not configured.");
  }
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const variant = await deps.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.sourceVariantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (variant.state !== "approved" && variant.state !== "published")
    return { ok: false, error: "CONTENT_NOT_APPROVED" };
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (item.creativeSlides) {
    const quality = validateSlideDeckQuality(item.creativeSlides);
    if (!quality.ok) return { ok: false, error: `CREATIVE_QUALITY_REJECTED:${quality.reason}` };
  }
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: variant.channelId,
  });
  if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  try {
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: deps.reelRenders,
      jobs: deps.jobQueue,
      renderId: randomUUID(),
      voiceMode: parsed.data.voice,
    });
    return {
      ok: true,
      value: {
        sourceVariantId: variant.id,
        status: result.render.status,
        attempt: result.render.attempt,
        voiceMode: result.render.voiceMode,
      },
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "channel_not_carousel") {
      return { ok: false, error: "CHANNEL_NOT_CAROUSEL" };
    }
    if (error instanceof Error && error.message === "content_not_approved") {
      return { ok: false, error: "CONTENT_NOT_APPROVED" };
    }
    throw error;
  }
};
