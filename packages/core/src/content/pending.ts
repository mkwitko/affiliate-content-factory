import type { ChannelKind } from "../channels/channel.js";
import type { PublicationAttempt } from "../publishing/publication.js";
import type { ContentItem, ContentVariant } from "./content.js";

export type PendingNextAction =
  | "approve"
  | "publish"
  | "manual_story"
  | "reconcile"
  | "wait"
  | "rebuild"
  | "build";

/** Variant states that can still need the operator. */
export const pendingVariantStates: readonly ContentVariant["state"][] = Object.freeze([
  "draft",
  "ready_for_review",
  "rejected",
  "approved",
]);
const unfinishedStates: ReadonlySet<ContentVariant["state"]> = new Set(pendingVariantStates);

/** The operator's next step for an unfinished variant, or null when nothing is pending. */
export const pendingNextAction = (
  variant: ContentVariant,
  attempt: PublicationAttempt | null,
  channelKind?: ChannelKind,
): PendingNextAction | null => {
  if (!unfinishedStates.has(variant.state)) return null;
  if (attempt?.status === "published") return null;
  if (
    attempt?.status === "queued" ||
    attempt?.status === "publishing" ||
    attempt?.status === "retryable_failure"
  )
    return "wait";
  if (attempt?.status === "unknown_outcome") return "reconcile";
  if (variant.state === "approved") {
    if (channelKind === "instagram_stories") return "manual_story";
    return "publish";
  }
  if (variant.state === "rejected") return "rebuild";
  return "approve";
};

/** Soft cancel for a post that never got a usable variant; the row stays for audit. */
export const cancelContentItem = (item: ContentItem): ContentItem => {
  if (item.state !== "draft") throw new Error("Only draft content items can be cancelled");
  return Object.freeze({ ...item, state: "cancelled" as const });
};
