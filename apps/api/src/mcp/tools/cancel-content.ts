import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { cancelVariant } from "@money-maker/core/content/approval";
import { cancelContentItem } from "@money-maker/core/content/pending";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { PublicationStatus } from "@money-maker/core/publishing/publication";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const cancelContentInputSchema = z
  .object({
    workspaceId: z.uuid(),
    variantId: z.string().trim().min(1).max(200).optional(),
    contentItemId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "A post that never got an active variant (list_pending_content kind content_item).",
      ),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .describe(
    "Cancel one unfinished content variant, or one post without active variants. Pass exactly one of variantId or contentItemId. Soft: the record stays for audit.",
  );

/** The worker may still publish while an attempt is in one of these states. */
const unsettled: ReadonlySet<PublicationStatus> = new Set([
  "queued",
  "publishing",
  "retryable_failure",
  "unknown_outcome",
]);

const SCHEDULE_CANCEL_MARGIN_MS = 2 * 60 * 1000;

export const cancelContentTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = cancelContentInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.publicationAttempts || !deps.audit)
    throw new Error("Cancel dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const { variantId, contentItemId, reason } = parsed.data;
  if (Boolean(variantId) === Boolean(contentItemId))
    return { ok: false, error: "INVALID_ARGUMENTS" };

  if (contentItemId) {
    // Only a post whose every variant is cancelled (or that has none) can be cancelled.
    const [item] = await deps.contentRepository.listContentItemsWithoutActiveVariants(workspaceId, {
      contentItemIds: [contentItemId],
    });
    if (!item) return { ok: false, error: "INVALID_CONTENT" };
    const stored = await deps.contentRepository.updateContentItemState({
      workspaceId,
      contentItemId,
      state: cancelContentItem(item).state,
    });
    if (!stored) return { ok: false, error: "CONTENT_NOT_FOUND" };
    await deps.audit.record({
      action: "content.cancelled",
      workspaceId,
      actorUserId: actorId,
      targetType: "content_item",
      targetId: contentItemId,
      metadata: { reason },
    });
    return { ok: true, value: { contentItem: stored } };
  }

  const variant = await deps.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: variantId ?? "",
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  let cancelled: ContentVariant;
  try {
    cancelled = cancelVariant(variant, reason);
  } catch {
    return { ok: false, error: "INVALID_CONTENT" };
  }
  const latest = (
    await deps.publicationAttempts.listLatestForVariants({ workspaceId, variantIds: [variant.id] })
  ).get(variant.id);
  // A scheduled post still waiting in the queue can be cancelled: the worker refuses a
  // cancelled variant when the job runs. The margin keeps clear of a job about to be claimed.
  const waitingSchedule =
    latest?.status === "queued" &&
    latest.scheduledAt !== undefined &&
    latest.scheduledAt.getTime() - Date.now() > SCHEDULE_CANCEL_MARGIN_MS;
  if (latest && unsettled.has(latest.status) && !waitingSchedule) {
    return { ok: false, error: "PUBLICATION_STILL_UNKNOWN" };
  }
  // A published attempt is a live post; the variant row stays "approved" after publication.
  if (latest?.status === "published") return { ok: false, error: "INVALID_CONTENT" };
  const stored = await deps.contentRepository.updateVariant(cancelled);
  await deps.audit.record({
    action: "content.cancelled",
    workspaceId,
    actorUserId: actorId,
    targetType: "content_variant",
    targetId: variant.id,
    metadata: { reason },
  });
  return { ok: true, value: { variant: stored } };
};
