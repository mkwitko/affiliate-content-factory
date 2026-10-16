import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  assertManualPublicationVariant,
  STORY_STICKER_TEXT,
} from "@money-maker/core/publishing/manual-publication";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getStoryKitInputSchema = z
  .object({ workspaceId: z.uuid(), variantId: z.string().trim().min(1).max(200) })
  .strict()
  .describe(
    "Everything to post one approved instagram_stories variant by hand in the Instagram app: slides in order, the official affiliate link, the caption, and the sticker text.",
  );

export const getStoryKitTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getStoryKitInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.channelRepository || !deps.assetStore) {
    throw new Error("Story kit dependencies are not configured.");
  }
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const variant = await deps.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: variant.channelId,
  });
  if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  // This kit is Instagram-specific (sticker text, affiliate link): a tiktok_video variant is a
  // manual-publication channel too, but has no story kit.
  if (channel.kind !== "instagram_stories") return { ok: false, error: "CHANNEL_NOT_STORIES" };
  try {
    assertManualPublicationVariant(variant, channel);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "channel_not_manual")
      return { ok: false, error: "CHANNEL_NOT_STORIES" };
    if (error instanceof Error && error.message === "content_not_approved")
      return { ok: false, error: "CONTENT_NOT_APPROVED" };
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  }
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!item?.offerId) return { ok: false, error: "EDITORIAL_PUBLICATION_NOT_ENABLED" };
  const offer = item
    ? await deps.offerRepository?.findForWorkspace({ workspaceId, offerId: item.offerId })
    : null;
  if (!offer?.affiliateUrl) return { ok: false, error: "CONTENT_NOT_FOUND" };
  // Short-lived signed URLs, in slide order; a missing asset drops out rather than failing the kit.
  const slides = (
    await Promise.all(
      variant.assetIds.map(async (assetId, index) => {
        const url = await deps.assetStore
          ?.createDownload({ workspaceId, assetId })
          .then((target) => target.url)
          .catch(() => null);
        return url ? { position: index + 1, assetId, url } : null;
      }),
    )
  ).filter((slide): slide is NonNullable<typeof slide> => slide !== null);
  return {
    ok: true,
    value: {
      slides,
      affiliateUrl: offer.affiliateUrl,
      caption: variant.caption,
      stickerText: STORY_STICKER_TEXT,
    },
  };
};
