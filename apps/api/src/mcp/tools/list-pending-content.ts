import { failedChecks, prepublishScoreFor } from "../../prepublish.js";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { pendingNextAction, pendingVariantStates } from "@money-maker/core/content/pending";
import type { ContentItem } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import { canvaEditUrl } from "@money-maker/core/content/preview-content";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument, requireList } from "./workspace-access.js";

export const listPendingContentInputSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .describe("List unfinished content variants with the operator's next action for each.");

const pendingLimit = 50;

export const listPendingContentTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listPendingContentInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.channelRepository || !deps.publicationAttempts)
    throw new Error("Pending content dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;

  // ponytail: fixed cap of the newest 50 unfinished variants; add paging if an operator
  // ever keeps more unfinished work than that.
  // Repository order is newest update first.
  const variants = await deps.contentRepository.listVariantsForWorkspace(workspaceId, {
    states: pendingVariantStates,
    limit: pendingLimit,
  });
  const attempts = await deps.publicationAttempts.listLatestForVariants({
    workspaceId,
    variantIds: variants.map((variant) => variant.id),
  });
  const channels = new Map(
    (await requireList(deps.channelRepository)(workspaceId)).map((channel) => [
      channel.id,
      channel,
    ]),
  );
  const offersById = new Map<string, Offer | null>();
  const offerById = async (offerId: string) => {
    if (!offersById.has(offerId)) {
      offersById.set(
        offerId,
        (await deps.offerRepository?.findForWorkspace({ workspaceId, offerId })) ?? null,
      );
    }
    return offersById.get(offerId) ?? null;
  };
  const itemsById = new Map<string, ContentItem | null>();
  const itemById = async (contentItemId: string) => {
    if (!itemsById.has(contentItemId)) {
      itemsById.set(
        contentItemId,
        (await deps.contentRepository?.findContentItemForWorkspace({
          workspaceId,
          contentItemId,
        })) ?? null,
      );
    }
    return itemsById.get(contentItemId) ?? null;
  };
  const offerForItem = async (contentItemId: string) => {
    const offerId = (await itemById(contentItemId))?.offerId;
    return offerId ? offerById(offerId) : null;
  };
  const policy = await deps.publicationPolicyRepository?.findForWorkspace(workspaceId);
  // Include cited evidence age and the official link for operator context; preview derives both itself.
  const offerFields = (offer: Offer | null, snapshotId: string | null) => ({
    offerId: offer?.id ?? null,
    offerTitle: offer?.title ?? null,
    evidenceVerifiedAt:
      offer?.snapshots.find((entry) => entry.id === snapshotId)?.verifiedAt.toISOString() ?? null,
    affiliateUrl: offer?.affiliateUrl ?? null,
  });

  const items = [];
  for (const variant of variants) {
    const attempt = attempts.get(variant.id) ?? null;
    const channel = channels.get(variant.channelId);
    const nextAction = pendingNextAction(variant, attempt, channel?.kind);
    if (!nextAction) continue;
    const contentItem = await itemById(variant.contentItemId);
    const score =
      channel && contentItem
        ? await prepublishScoreFor({
            workspaceId,
            variant,
            item: contentItem,
            channel,
            offer: await offerForItem(variant.contentItemId),
            policy,
            reelRenders: deps.reelRenders,
          })
        : null;
    items.push({
      kind: "variant" as const,
      variantId: variant.id,
      contentItemId: variant.contentItemId,
      channelId: variant.channelId,
      channelName: channel?.label ?? null,
      channelKind: channel?.kind ?? null,
      ...offerFields(await offerForItem(variant.contentItemId), variant.offerSnapshotId),
      state: variant.state,
      caption: variant.caption,
      assetCount: variant.assetIds.length,
      creativeRender: variant.creativeRender
        ? {
            state: variant.creativeRender.state,
            reason: variant.creativeRender.reason ?? null,
            fidelity: variant.creativeRender.fidelity
              ? {
                  verdict: variant.creativeRender.fidelity.verdict,
                  // Stored JSON: a corrupted row must not break the whole listing.
                  slides: (Array.isArray(variant.creativeRender.fidelity.slides)
                    ? variant.creativeRender.fidelity.slides
                    : []
                  )
                    .filter((slide) => slide.verdict !== "pass")
                    .map((slide) => ({
                      slideIndex: slide.slideIndex,
                      verdict: slide.verdict,
                      reasons: slide.reasons,
                    })),
                }
              : null,
          }
        : null,
      prepublishScore: score
        ? { score: score.score, verdict: score.verdict, failedChecks: failedChecks(score) }
        : null,
      rejectionReason: variant.rejectionReason ?? null,
      design: variant.design ?? null,
      editUrl: variant.design ? canvaEditUrl(variant.design.canvaDesignId) : null,
      attempt: attempt
        ? {
            attemptId: attempt.attemptId,
            status: attempt.status,
            updatedAt: attempt.updatedAt,
            ...(attempt.scheduledAt ? { scheduledAt: attempt.scheduledAt } : {}),
          }
        : null,
      nextAction,
    });
  }
  // Posts that stopped before any usable variant (for example an interrupted Canva export).
  const orphans = await deps.contentRepository.listContentItemsWithoutActiveVariants(workspaceId, {
    limit: pendingLimit,
  });
  for (const orphan of orphans) {
    items.push({
      kind: "content_item" as const,
      variantId: null,
      contentItemId: orphan.id,
      title: orphan.title,
      channelId: null,
      channelName: null,
      channelKind: null,
      ...offerFields(
        orphan.offerId ? await offerById(orphan.offerId) : null,
        orphan.offerSnapshotId,
      ),
      state: orphan.state,
      caption: null,
      assetCount: 0,
      rejectionReason: null,
      design: null,
      editUrl: null,
      attempt: null,
      nextAction: "build" as const,
    });
  }
  return { ok: true, value: { items } };
};
