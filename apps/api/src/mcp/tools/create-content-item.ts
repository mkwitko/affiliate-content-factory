import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createContentItem } from "@money-maker/core/content/content";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const createContentItemInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    offerId: z.string().trim().min(1).max(200).optional(),
    sourceContentItemId: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500),
    sourceFactKeys: z.array(z.string().trim().min(1).max(100)).max(100),
    sourcePictureAssetIds: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    creativeOpinion: z.string().trim().min(1).max(4000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.offerId && value.sourceFactKeys.length)
      context.addIssue({ code: "custom", message: "sourceFactKeys require offerId" });
    if (!value.offerId && value.sourcePictureAssetIds?.length)
      context.addIssue({ code: "custom", message: "sourcePictureAssetIds require offerId" });
    if (value.offerId && value.sourceFactKeys.length === 0)
      context.addIssue({ code: "custom", message: "commerce content requires sourceFactKeys" });
  });
export const createContentItemTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createContentItemInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.nicheRepository ||
    !deps.contentRepository ||
    (parsed.data?.offerId !== undefined && !deps.offerRepository)
  )
    return parsed.success
      ? (() => {
          throw new Error("Content dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const [niche, offer] = await Promise.all([
    deps.nicheRepository.findForWorkspace({ workspaceId, nicheId: parsed.data.nicheId }),
    parsed.data.offerId && deps.offerRepository
      ? deps.offerRepository.findForWorkspace({ workspaceId, offerId: parsed.data.offerId })
      : null,
  ]);
  // Media niches build audiences, not offers: offer-bound items belong to affiliate niches.
  if (niche?.kind === "media" && parsed.data.offerId)
    return { ok: false, error: "NICHE_KIND_MISMATCH" };
  if (!niche || niche.workspaceId !== workspaceId || (parsed.data.offerId && !offer))
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (
    parsed.data.sourceContentItemId &&
    !(await deps.contentRepository.findContentItemForWorkspace({
      workspaceId,
      contentItemId: parsed.data.sourceContentItemId,
    }))
  )
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  try {
    if (parsed.data.sourcePictureAssetIds?.length) {
      if (!deps.assetRepository)
        return { ok: false, error: "INVALID_CONTENT:asset_repository_unavailable" };
      const sourceAssets = await Promise.all(
        parsed.data.sourcePictureAssetIds.map((assetId) =>
          deps.assetRepository?.findForWorkspace({ workspaceId, assetId }),
        ),
      );
      if (
        sourceAssets.some(
          (asset) => asset?.state !== "active" || asset.license !== "Mercado Livre listing photo",
        )
      )
        return { ok: false, error: "INVALID_CONTENT:source_picture_not_listing_photo" };
    }
    const { sourcePictureAssetIds, sourceContentItemId, ...contentInput } = parsed.data;
    const item = createContentItem({
      ...contentInput,
      ...(sourceContentItemId ? { sourceContentItemId } : {}),
      ...(sourcePictureAssetIds ? { sourcePictureAssetIds } : {}),
      workspaceId,
      ...(offer ? { offer } : {}),
    });
    return {
      ok: true,
      value: { contentItem: await deps.contentRepository.createContentItem(item) },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return { ok: false, error: `INVALID_CONTENT:${reason.slice(0, 200)}` };
  }
};
