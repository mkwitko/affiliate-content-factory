import { createHash, randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import {
  isManualOnlyChannelKind,
  isPublishableChannelKind,
} from "@money-maker/core/channels/channel";
import { requestPublication } from "@money-maker/core/publishing/request-publication";
import {
  assetRightsFingerprint,
  isCountingEditorialReview,
} from "@money-maker/core/content/editorial";
import { resolveAssetRights } from "@money-maker/core/assets/asset-rights";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import { offerDestination } from "@money-maker/core/offers/offer";
import { z } from "zod";
import { assertTikTokShopPublishable } from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies, ToolResult } from "../server.js";

export const publishContentInputSchema = z
  .object({
    workspaceId: z.uuid(),
    contentVariantId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(1).max(200),
    publishAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Schedule instead of publishing now: ISO date-time with offset (e.g. 2026-09-25T19:00:00-03:00), at least 5 minutes and at most 60 days ahead.",
      ),
  })
  .strict()
  .describe("Queues one approved content variant for publication now, or at publishAt.");

const MIN_SCHEDULE_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_MS = 60 * 24 * 60 * 60 * 1000;

export const publishContentTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = publishContentInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const publishAt = parsed.data.publishAt ? new Date(parsed.data.publishAt) : undefined;
  if (publishAt) {
    const ahead = publishAt.getTime() - Date.now();
    if (ahead < MIN_SCHEDULE_MS || ahead > MAX_SCHEDULE_MS) {
      return { ok: false, error: "INVALID_ARGUMENTS" };
    }
  }
  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles: ["owner", "operator"],
  });
  if (!authorization.ok) return { ok: false, error: "FORBIDDEN" };
  if (
    !dependencies.contentRepository ||
    !dependencies.channelRepository ||
    !dependencies.providerConnections ||
    !dependencies.publicationAttempts ||
    !dependencies.jobQueue
  ) {
    throw new Error("Publication dependencies are not configured.");
  }
  const variant = await dependencies.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.contentVariantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const channel = await dependencies.channelRepository.findForWorkspace({
    workspaceId,
    channelId: variant.channelId,
  });
  if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (isManualOnlyChannelKind(channel.kind))
    return { ok: false, error: "MANUAL_PUBLICATION_REQUIRED" };
  const contentItem = await dependencies.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!contentItem) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (channel.kind === "youtube" && publishAt) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (channel.kind === "youtube" && !variant.publishSpec)
    return { ok: false, error: "PUBLISH_SPEC_MISSING" };
  // TikTok growth content has no offer, as with record_manual_publication.
  if (
    contentItem.offerId === null &&
    channel.kind !== "youtube" &&
    channel.kind !== "tiktok_video" &&
    channel.kind !== "tiktok_photo_post"
  )
    return { ok: false, error: "EDITORIAL_PUBLICATION_NOT_ENABLED" };
  if (!isPublishableChannelKind(channel.kind)) return { ok: false, error: "CHANNEL_UNSUPPORTED" };
  const connection = await dependencies.providerConnections.findForWorkspace({
    workspaceId,
    connectionId: channel.connectionId,
  });
  if (!connection) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const offer =
    contentItem.offerId && dependencies.offerRepository
      ? await dependencies.offerRepository.findForWorkspace({
          workspaceId,
          offerId: contentItem.offerId,
        })
      : null;
  if (offer?.marketplace === "tiktok_shop") {
    try {
      assertTikTokShopPublishable({
        channel,
        offer,
        snapshot: offer.snapshots.find((snapshot) => snapshot.id === offer.activeSnapshotId),
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "shop_not_enabled")
        return { ok: false, error: "SHOP_NOT_ENABLED" };
      if (error instanceof Error && error.message === "commercial_snapshot_stale")
        return { ok: false, error: "COMMERCIAL_SNAPSHOT_STALE" };
      throw error;
    }
  }
  if (variant.approval?.publicationFingerprint) {
    const assets = dependencies.assetRepository
      ? await Promise.all(
          variant.assetIds.map((assetId) =>
            dependencies.assetRepository?.findForWorkspace({ workspaceId, assetId }),
          ),
        )
      : [];
    if (
      (contentItem.offerId && !offer) ||
      assets.length !== variant.assetIds.length ||
      assets.some((asset) => !asset)
    )
      return { ok: false, error: "APPROVAL_STALE" };
    const thumbnail =
      variant.publishSpec?.thumbnailAssetId && dependencies.assetRepository
        ? await dependencies.assetRepository.findForWorkspace({
            workspaceId,
            assetId: variant.publishSpec.thumbnailAssetId,
          })
        : null;
    const destination = offer ? offerDestination(offer) : null;
    const current = publicationFingerprint({
      schemaVersion: 1,
      variantId: variant.id,
      channelId: channel.id,
      connectionId: connection.id,
      destinationFingerprint: destination ? destinationFingerprint(destination) : null,
      caption: variant.caption,
      publishSpec: variant.publishSpec ?? null,
      mediaAssetChecksums: assets.map((asset) => asset?.checksum ?? ""),
      thumbnailChecksum: thumbnail?.checksum ?? null,
      language: variant.language,
      voiceScript: variant.voiceScript,
    });
    if (current !== variant.approval.publicationFingerprint)
      return { ok: false, error: "APPROVAL_STALE" };
    if (variant.publishSpec?.thumbnailAssetId && !thumbnail)
      return { ok: false, error: "THUMBNAIL_INVALID" };
    if (channel.kind === "youtube") {
      const rightsAssets = [
        ...assets.filter(
          (asset): asset is NonNullable<typeof asset> => asset !== null && asset !== undefined,
        ),
        ...(thumbnail ? [thumbnail] : []),
      ];
      const review = await dependencies.editorialRepository?.findCurrentReview({
        workspaceId,
        variantId: variant.id,
      });
      if (
        !review ||
        !isCountingEditorialReview(review, current) ||
        review.rightsFingerprint !== assetRightsFingerprint(rightsAssets) ||
        rightsAssets.some((asset) => asset.commercialUse !== true)
      )
        return { ok: false, error: "EDITORIAL_REVIEW_STALE" };
    }
  }
  if (channel.kind === "youtube" && !variant.approval?.publicationFingerprint)
    return { ok: false, error: "APPROVAL_STALE" };
  try {
    const result = await requestPublication({
      workspaceId,
      variant,
      channel,
      connection,
      attempts: dependencies.publicationAttempts,
      queue: dependencies.jobQueue,
      attemptId: randomUUID(),
      idempotencyKey: parsed.data.idempotencyKey,
      requestFingerprint: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"),
      correlationId: randomUUID(),
      ...(publishAt ? { publishAt } : {}),
    });
    return {
      ok: true,
      value: {
        publication: result.attempt,
        created: result.created,
        affiliateUrl: offer?.affiliateUrl ?? null,
      },
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "content_not_approved")
      return { ok: false, error: "CONTENT_NOT_APPROVED" };
    if (error instanceof Error && error.message === "provider_connection_unavailable")
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    throw error;
  }
};
