import type { WorkspaceId } from "@money-maker/contracts";
import type { Channel } from "../channels/channel.js";
import { isManualPublicationChannelKind } from "../channels/channel.js";
import type { ContentVariant } from "../content/content.js";
import type {
  CreateOrFindPublicationAttemptResult,
  PublicationAttemptRepository,
} from "./publication.js";

/** Instagram has no sticker API, so a Stories post is made by hand in the app. */
export const STORY_STICKER_TEXT = "Ver oferta";

export const manualPublicationIdempotencyKey = (variantId: string): string => `manual:${variantId}`;

/**
 * Throws channel_not_manual (channel.kind is not instagram_stories or tiktok_video, the two
 * channels with no publisher API path), content_not_approved, or a workspace/channel mismatch.
 */
export const assertManualPublicationVariant = (variant: ContentVariant, channel: Channel): void => {
  if (variant.workspaceId !== channel.workspaceId)
    throw new Error("publication_workspace_mismatch");
  if (variant.channelId !== channel.id) throw new Error("publication_channel_mismatch");
  if (!isManualPublicationChannelKind(channel.kind)) throw new Error("channel_not_manual");
  if (variant.state !== "approved" || !variant.approval) throw new Error("content_not_approved");
};

export const recordManualPublication = async (
  input: Readonly<{
    workspaceId: WorkspaceId;
    variant: ContentVariant;
    channel: Channel;
    attempts: PublicationAttemptRepository;
    attemptId: string;
    requestFingerprint: string;
    correlationId: string;
    publishedAt: Date;
  }>,
): Promise<CreateOrFindPublicationAttemptResult> => {
  if (
    input.variant.workspaceId !== input.workspaceId ||
    input.channel.workspaceId !== input.workspaceId
  ) {
    throw new Error("publication_workspace_mismatch");
  }
  assertManualPublicationVariant(input.variant, input.channel);
  return input.attempts.createOrFindManualPublication({
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    contentVariantId: input.variant.id,
    channelId: input.channel.id,
    connectionId: input.channel.connectionId,
    idempotencyKey: manualPublicationIdempotencyKey(input.variant.id),
    requestFingerprint: input.requestFingerprint,
    correlationId: input.correlationId,
    publishedAt: input.publishedAt,
  });
};
