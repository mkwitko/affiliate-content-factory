import {
  createRedirect,
  destinationFingerprint,
  TRACKED_LINK_TTL_MS,
  trackedUrl,
  withOfficialLink,
} from "@money-maker/core/analytics/attribution";
import type { AttributionRepository } from "@money-maker/core/analytics/attribution-repository";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import { resolveAssetRights } from "@money-maker/core/assets/asset-rights";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  type ChannelKind,
  isManualOnlyChannelKind,
  isPublishableChannelKind,
} from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import { assertTikTokShopPublishable } from "@money-maker/core/channels/tiktok-shop-status";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import {
  assetRightsFingerprint,
  isCountingEditorialReview,
} from "@money-maker/core/content/editorial";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import {
  createReconcilePublicationJob,
  type JobIdentifierPayload,
  type JobQueue,
  publishContentMaxAttempts,
} from "@money-maker/core/jobs/job";
import type {
  MarketplaceCatalog,
  ProductEvidence,
} from "@money-maker/core/offers/marketplace-catalog";
import {
  isMercadoLivreAffiliateUrl,
  offerDestination,
  productIdFromOffer,
} from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import {
  checkPublishFreshness,
  PUBLISH_MAX_SNAPSHOT_AGE_MS,
} from "@money-maker/core/offers/publish-freshness";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { SocialPublisher } from "@money-maker/core/publishing/social-publisher";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";

export type PublishContentResult =
  | Readonly<{ action: "published"; externalId: string }>
  | Readonly<{
      action: "retryable_failure" | "permanent_failure" | "unknown_outcome";
      reason: string;
    }>;

export type PublishContentDependencies = Readonly<{
  attempts: PublicationAttemptRepository;
  content: Pick<ContentRepository, "findVariantForWorkspace" | "findContentItemForWorkspace">;
  offers: Pick<OfferRepository, "findForWorkspace" | "addSnapshot">;
  catalogForWorkspace: (workspaceId: JobIdentifierPayload["workspaceId"]) => MarketplaceCatalog;
  channels: Pick<ChannelRepository, "findForWorkspace">;
  connections: Pick<ProviderConnectionRepository, "findForWorkspace">;
  policies: Pick<PublicationPolicyRepository, "findForWorkspace">;
  attributionRepository?: AttributionRepository;
  publicApiUrl?: string;
  assets?: AssetStore;
  assetRepository?: AssetRepository;
  editorialRepository?: EditorialRepository;
  /** Enqueues reconcile_publication when the provider outcome is unknown. */
  jobs?: Pick<JobQueue, "enqueue">;
  publisher:
    | SocialPublisher
    | ((workspaceId: JobIdentifierPayload["workspaceId"]) => SocialPublisher);
}>;

/** attemptCount is the queue's run number for this job, counted from 1 at claim. */
type PublishContentJob = Readonly<{ payload: JobIdentifierPayload; attemptCount?: number }>;

const failureAction = (
  error: unknown,
): Extract<
  PublishContentResult,
  { action: "retryable_failure" | "unknown_outcome" | "permanent_failure" }
> => {
  const reason = error instanceof Error ? error.message : "provider_unknown_outcome";
  if (reason === "provider_timeout" || reason === "provider_unknown_outcome") {
    return { action: "unknown_outcome", reason };
  }
  if (
    reason === "provider_rate_limited" ||
    reason === "provider_network_failure" ||
    reason === "click_tracking_unavailable"
  ) {
    return { action: "retryable_failure", reason };
  }
  return { action: "permanent_failure", reason };
};

const permanent = (reason: string): PublishContentResult => ({
  action: "permanent_failure",
  reason,
});

const platformForChannel = (
  kind: ChannelKind,
): "instagram" | "threads" | "youtube" | "tiktok" | null => {
  if (!isPublishableChannelKind(kind)) return null;
  if (kind === "threads" || kind === "youtube") return kind;
  if (kind === "tiktok_video" || kind === "tiktok_photo_post") return "tiktok";
  return "instagram";
};

const placementForChannel = (kind: ChannelKind): "timeline" | "stories" | "reels" => {
  if (kind === "instagram_stories") return "stories";
  if (kind === "instagram_reels") return "reels";
  return "timeline";
};

const existingResult = (attempt: PublicationAttempt): PublishContentResult | null => {
  if (attempt.status === "published" && attempt.externalId) {
    return { action: "published", externalId: attempt.externalId };
  }
  if (attempt.status === "unknown_outcome") {
    return {
      action: "unknown_outcome",
      reason: attempt.terminalReason ?? "provider_unknown_outcome",
    };
  }
  if (attempt.status === "permanent_failure" || attempt.status === "cancelled") {
    return {
      action: "permanent_failure",
      reason: attempt.terminalReason ?? "publication_not_allowed",
    };
  }
  if (attempt.status === "publishing") {
    return { action: "permanent_failure", reason: "publication_already_claimed" };
  }
  return null;
};

export const createPublishContentHandler =
  (dependencies: PublishContentDependencies) =>
  async (job: PublishContentJob): Promise<PublishContentResult> => {
    const attemptId = job.payload.identifiers.attemptId;
    const workspaceId = job.payload.workspaceId;
    if (!attemptId) return permanent("publication_attempt_id_missing");
    const attempt = await dependencies.attempts.findForWorkspace({ workspaceId, attemptId });
    if (!attempt) return permanent("publication_attempt_not_found");
    const scheduleReconcile = async () => {
      // Own key: the Post For Me webhook enqueues reconcile-publication:{attemptId}, and an
      // exhausted job under that key would swallow the webhook's later enqueue.
      await dependencies.jobs?.enqueue({
        ...createReconcilePublicationJob({ workspaceId, attemptId }),
        idempotencyKey: `reconcile:${attemptId}`,
      });
    };
    if (attempt.status === "publishing") {
      // A previous run claimed this attempt and never finished (crash or expired lease):
      // the provider may or may not have posted it.
      await dependencies.attempts.recordFailure({
        workspaceId,
        attemptId,
        status: "unknown_outcome",
        reason: "publication_interrupted",
      });
      await scheduleReconcile();
      return { action: "unknown_outcome", reason: "publication_interrupted" };
    }
    const alreadyResolved = existingResult(attempt);
    // A retried job lands here when the previous run recorded unknown_outcome but failed to
    // enqueue the reconcile; the upsert on the job key makes this enqueue idempotent.
    if (alreadyResolved?.action === "unknown_outcome") await scheduleReconcile();
    if (alreadyResolved) return alreadyResolved;

    const reject = async (reason: string): Promise<PublishContentResult> => {
      await dependencies.attempts.recordFailure({
        workspaceId,
        attemptId,
        status: "permanent_failure",
        reason,
      });
      return permanent(reason);
    };

    const variant = await dependencies.content.findVariantForWorkspace({
      workspaceId,
      variantId: attempt.contentVariantId,
    });
    if (variant?.state !== "approved" || !variant.approval) {
      return reject("content_not_approved");
    }
    const connection = await dependencies.connections.findForWorkspace({
      workspaceId,
      connectionId: attempt.connectionId,
    });
    if (connection?.status !== "active") return reject("connection_unavailable");
    const channel = await dependencies.channels.findForWorkspace({
      workspaceId,
      channelId: attempt.channelId,
    });
    if (channel?.status !== "active" || channel.connectionId !== connection.id) {
      return reject("channel_unavailable");
    }
    // Defence in depth: publish_content already refuses a manual channel before queuing a job.
    if (isManualOnlyChannelKind(channel.kind)) return reject("manual_publication_required");
    const policy = await dependencies.policies.findForWorkspace(workspaceId);
    if (policy.workspaceId !== workspaceId || policy.mode === "paused") {
      return reject("publication_policy_paused");
    }
    const platform = platformForChannel(channel.kind);
    if (!platform) return reject("platform_unsupported");

    const contentItem = await dependencies.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId: variant.contentItemId,
    });
    if (!contentItem) return reject("offer_unavailable");
    const youtube = channel.kind === "youtube";
    const tiktok = platform === "tiktok";
    if (youtube && !variant.approval?.publicationFingerprint) return reject("approval_stale");
    // TikTok growth content has no offer, as with record_manual_publication.
    if (contentItem.offerId === null && !youtube && !tiktok) {
      return reject("editorial_publication_not_enabled");
    }
    if (youtube && !variant.publishSpec) return reject("youtube_publish_spec_invalid");
    const offer = contentItem.offerId
      ? await dependencies.offers.findForWorkspace({ workspaceId, offerId: contentItem.offerId })
      : null;
    if (contentItem.offerId && (offer?.state !== "active" || !variant.offerSnapshotId)) {
      return reject("offer_unavailable");
    }
    if (youtube) {
      const script = await dependencies.editorialRepository?.findScriptVersion({
        workspaceId,
        contentItemId: contentItem.id,
      });
      if (!script || script.status !== "approved" || script.approvedChecksum !== script.checksum)
        return reject("script_not_approved");
    }
    const fingerprintFailure = async (): Promise<string | null> => {
      const approvedFingerprint = variant.approval?.publicationFingerprint;
      if (approvedFingerprint === null || approvedFingerprint === undefined) return null;
      if (!dependencies.assetRepository) return "asset_store_unavailable";
      const approvedAssets = await Promise.all(
        variant.assetIds.map((assetId) =>
          dependencies.assetRepository?.findForWorkspace({ workspaceId, assetId }),
        ),
      );
      if (approvedAssets.some((asset) => !asset || asset.workspaceId !== workspaceId))
        return "asset_unavailable";
      const thumbnail = variant.publishSpec?.thumbnailAssetId
        ? await dependencies.assetRepository.findForWorkspace({
            workspaceId,
            assetId: variant.publishSpec.thumbnailAssetId,
          })
        : null;
      if (variant.publishSpec?.thumbnailAssetId && !thumbnail) return "thumbnail_invalid";
      const destination = offer ? offerDestination(offer) : null;
      const currentFingerprint = publicationFingerprint({
        schemaVersion: 1,
        variantId: variant.id,
        channelId: channel.id,
        connectionId: connection.id,
        destinationFingerprint: destination ? destinationFingerprint(destination) : null,
        caption: variant.caption,
        publishSpec: variant.publishSpec ?? null,
        mediaAssetChecksums: approvedAssets.map((asset) => asset?.checksum ?? ""),
        thumbnailChecksum: thumbnail?.checksum ?? null,
        language: variant.language,
        voiceScript: variant.voiceScript,
      });
      if (currentFingerprint !== approvedFingerprint) return "approval_stale";
      if (youtube) {
        const review = await dependencies.editorialRepository?.findCurrentReview({
          workspaceId,
          variantId: variant.id,
        });
        const rightsAssets = await resolveAssetRights({
          workspaceId,
          assets: [
            ...approvedAssets.filter((asset) => asset !== null && asset !== undefined),
            ...(thumbnail ? [thumbnail] : []),
          ],
          findAsset: (assetId) =>
            dependencies.assetRepository!.findForWorkspace({ workspaceId, assetId }),
        });
        if (
          !review ||
          !isCountingEditorialReview(review, currentFingerprint) ||
          review.rightsFingerprint !== assetRightsFingerprint(rightsAssets) ||
          rightsAssets.some((asset) => asset.commercialUse !== true)
        )
          return "rights_unverified";
      }
      return null;
    };
    const preflightFingerprintFailure = await fingerprintFailure();
    if (preflightFingerprintFailure) return reject(preflightFingerprintFailure);
    if (offer?.marketplace === "tiktok_shop") {
      try {
        assertTikTokShopPublishable({
          channel,
          offer,
          snapshot: offer.snapshots.find((snapshot) => snapshot.id === offer.activeSnapshotId),
          now: new Date(),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "shop_not_enabled" || error.message === "commercial_snapshot_stale")
        )
          return reject(error.message);
        throw error;
      }
    } else if (offer) {
      try {
        if (!offer.affiliateUrl || !isMercadoLivreAffiliateUrl(new URL(offer.affiliateUrl))) {
          return reject("affiliate_url_invalid");
        }
      } catch {
        return reject("affiliate_url_invalid");
      }

      const now = new Date();
      const citedSnapshot = offer.snapshots.find(
        (snapshot) => snapshot.id === variant.offerSnapshotId,
      );
      const snapshotAge = citedSnapshot
        ? now.getTime() - citedSnapshot.verifiedAt.getTime()
        : Infinity;
      let evidence: ProductEvidence | null = null;
      if (snapshotAge > PUBLISH_MAX_SNAPSHOT_AGE_MS || snapshotAge < 0) {
        const productId = productIdFromOffer(offer);
        if (productId) {
          try {
            evidence = await dependencies
              .catalogForWorkspace(workspaceId)
              .readProductEvidence(productId);
          } catch (error) {
            if (
              error instanceof Error &&
              (error.message === "listing_unavailable" || error.message === "no_active_offer")
            )
              return reject("listing_unavailable");
          }
        }
      }
      const freshness = checkPublishFreshness({
        offer,
        citedSnapshotId: variant.offerSnapshotId ?? "",
        evidence,
        now,
      });
      if (!freshness.ok) {
        if (
          freshness.reason === "evidence_unverifiable" &&
          (job.attemptCount ?? 1) < publishContentMaxAttempts
        ) {
          await dependencies.attempts.recordFailure({
            workspaceId,
            attemptId,
            status: "retryable_failure",
            reason: freshness.reason,
          });
          return { action: "retryable_failure", reason: freshness.reason };
        }
        return reject(freshness.reason);
      }
      if (evidence) {
        const stored = await dependencies.offers.addSnapshot({
          workspaceId,
          offerId: offer.id,
          snapshot: freshness.snapshot,
        });
        if (!stored) return reject("offer_unavailable");
      }
    }

    const claimed = await dependencies.attempts.markPublishing({ workspaceId, attemptId });
    if (!claimed) {
      const current = await dependencies.attempts.findForWorkspace({ workspaceId, attemptId });
      return current
        ? (existingResult(current) ?? permanent("publication_already_claimed"))
        : permanent("publication_attempt_not_found");
    }
    const claimedFingerprintFailure = await fingerprintFailure();
    if (claimedFingerprintFailure) return reject(claimedFingerprintFailure);

    try {
      const mediaUrls: string[] = [];
      for (const assetId of variant.assetIds) {
        if (!dependencies.assets) return reject("asset_store_unavailable");
        const target = await dependencies.assets.createDownload({ workspaceId, assetId });
        mediaUrls.push(target.url);
      }
      const finalGateFailure = await fingerprintFailure();
      if (finalGateFailure) return reject(finalGateFailure);
      const thumbnailAssetId = variant.publishSpec?.thumbnailAssetId;
      const thumbnailUrl =
        thumbnailAssetId && dependencies.assets
          ? (await dependencies.assets.createDownload({ workspaceId, assetId: thumbnailAssetId }))
              .url
          : undefined;
      const publisher =
        typeof dependencies.publisher === "function"
          ? dependencies.publisher(workspaceId)
          : dependencies.publisher;
      let publishText = variant.caption;
      const attributionRepository = dependencies.attributionRepository;
      const findForPublicationAttempt = attributionRepository?.findForPublicationAttempt;
      if (
        offer?.marketplace === "mercado_livre" &&
        offer.affiliateUrl &&
        attributionRepository &&
        findForPublicationAttempt &&
        dependencies.publicApiUrl
      ) {
        try {
          const existing = await findForPublicationAttempt.call(attributionRepository, {
            workspaceId,
            attemptId,
          });
          const destination = new URL(offer.affiliateUrl);
          let redirect = existing;
          if (redirect) {
            if (redirect.destinationFingerprint !== destinationFingerprint(destination.toString()))
              throw new Error("publication_redirect_destination_changed");
          } else {
            const variantLink = await attributionRepository.findForVariant({
              workspaceId,
              contentVariantId: variant.id,
            });
            redirect = await attributionRepository.createRedirect(
              createRedirect({
                workspaceId,
                destination,
                expiresAt: new Date(Date.now() + TRACKED_LINK_TTL_MS),
                contentVariantId: variant.id,
                publicationAttemptId: attemptId,
                offerId: offer.id,
                fallback: new URL(offer.listingUrl),
                ...(variantLink?.marketplaceLabel
                  ? { marketplaceLabel: variantLink.marketplaceLabel }
                  : {}),
              }),
            );
          }
          publishText = withOfficialLink(
            variant.caption,
            trackedUrl(dependencies.publicApiUrl, redirect.slug),
            dependencies.publicApiUrl,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "publication_redirect_destination_changed"
          ) {
            throw error;
          }
          throw new Error("click_tracking_unavailable");
        }
      }
      const result = await publisher.publish({
        secretReference: connection.secretReference,
        accountId: connection.accountId,
        platform,
        text: publishText,
        ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
        idempotencyKey: attempt.attemptId,
        ...(connection.displayName ? { accountHandle: connection.displayName } : {}),
        placement: placementForChannel(channel.kind),
        ...(youtube && variant.publishSpec
          ? { youtube: { spec: variant.publishSpec, ...(thumbnailUrl ? { thumbnailUrl } : {}) } }
          : {}),
      });
      if (result.status === "published") {
        await dependencies.attempts.recordPublished({
          workspaceId,
          attemptId,
          externalId: result.externalId,
        });
        return { action: "published", externalId: result.externalId };
      }
      if (result.status === "failed") {
        const reason = `provider_post_failed: ${result.failureReason ?? "provider_post_failed"}`;
        await dependencies.attempts.recordFailure({
          workspaceId,
          attemptId,
          status: "permanent_failure",
          reason,
        });
        return { action: "permanent_failure", reason };
      }
      // Accepted by the provider but not yet resolved per account: revisit via reconciliation.
      await dependencies.attempts.recordFailure({
        workspaceId,
        attemptId,
        status: "unknown_outcome",
        reason: "provider_still_processing",
      });
      await scheduleReconcile();
      return { action: "unknown_outcome", reason: "provider_still_processing" };
    } catch (error: unknown) {
      const classified = failureAction(error);
      // On the queue's last run a retryable failure is final; record it so the attempt
      // does not stay "retryable_failure" after the job is exhausted.
      const failure =
        classified.action === "retryable_failure" &&
        (job.attemptCount ?? 0) >= publishContentMaxAttempts
          ? { action: "permanent_failure" as const, reason: classified.reason }
          : classified;
      await dependencies.attempts.recordFailure({
        workspaceId,
        attemptId,
        status: failure.action,
        reason: failure.reason,
      });
      if (failure.action === "unknown_outcome") await scheduleReconcile();
      return failure;
    }
  };
