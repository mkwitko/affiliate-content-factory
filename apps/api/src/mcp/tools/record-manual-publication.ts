import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { recordManualPublication } from "@money-maker/core/publishing/manual-publication";
import { assertTikTokShopPublishable } from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const recordManualPublicationInputSchema = z
  .object({ workspaceId: z.uuid(), variantId: z.string().trim().min(1).max(200) })
  .strict()
  .describe(
    "Record that an approved instagram_stories, tiktok_video or tiktok_photo_post variant was posted by hand (Instagram Stories after get_story_kit; TikTok after attaching the Shop product, when applicable, in the TikTok app). Idempotent per variant: a repeat call returns the same publication.",
  );

export const recordManualPublicationTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordManualPublicationInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.channelRepository || !deps.publicationAttempts) {
    throw new Error("Manual publication dependencies are not configured.");
  }
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const variant = await deps.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (variant.state !== "approved" || !variant.approval)
    return { ok: false, error: "CONTENT_NOT_APPROVED" };
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: variant.channelId,
  });
  if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  // TikTok growth content has no offer; editorial manual publication stays disabled for Stories.
  if (
    item.offerId === null &&
    channel.kind !== "tiktok_video" &&
    channel.kind !== "tiktok_photo_post"
  )
    return { ok: false, error: "EDITORIAL_PUBLICATION_NOT_ENABLED" };
  if (item.offerId) {
    if (!deps.offerRepository)
      throw new Error("Manual publication dependencies are not configured.");
    const offer = await deps.offerRepository.findForWorkspace({
      workspaceId,
      offerId: item.offerId,
    });
    if (!offer) return { ok: false, error: "CONTENT_NOT_FOUND" };
    if (offer.marketplace === "tiktok_shop") {
      const activeSnapshot = offer.snapshots.find(
        (snapshot) => snapshot.id === offer.activeSnapshotId,
      );
      try {
        assertTikTokShopPublishable({ channel, offer, snapshot: activeSnapshot, now: new Date() });
      } catch (error) {
        if (error instanceof Error && error.message === "shop_not_enabled")
          return { ok: false, error: "SHOP_NOT_ENABLED" };
        if (error instanceof Error && error.message === "commercial_snapshot_stale")
          return { ok: false, error: "COMMERCIAL_SNAPSHOT_STALE" };
        throw error;
      }
    }
  }
  try {
    const result = await recordManualPublication({
      workspaceId,
      variant,
      channel,
      attempts: deps.publicationAttempts,
      attemptId: randomUUID(),
      requestFingerprint: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"),
      correlationId: randomUUID(),
      publishedAt: new Date(),
    });
    return { ok: true, value: { publication: result.attempt, created: result.created } };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "channel_not_manual")
      return { ok: false, error: "CHANNEL_NOT_MANUAL" };
    if (error instanceof Error && error.message === "content_not_approved")
      return { ok: false, error: "CONTENT_NOT_APPROVED" };
    throw error;
  }
};
