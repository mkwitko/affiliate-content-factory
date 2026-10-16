import { isVerticalLayout } from "@money-maker/core/assets/clip-renderer";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { isPublishableChannelKind } from "@money-maker/core/channels/channel";
import {
  createVariant,
  snapshotStillBacksContent,
  validateVariantForReview,
} from "@money-maker/core/content/content";
import {
  createRedirect,
  destinationFingerprint,
  TRACKED_LINK_TTL_MS,
  trackedUrl,
  withOfficialLink,
} from "@money-maker/core/analytics/attribution";
import { isMercadoLivreAffiliateUrl } from "@money-maker/core/offers/offer";
import { commerceDestinationFor } from "@money-maker/core/channels/commerce-destination";
import { captionHasLinkForTikTok } from "@money-maker/core/content/preview-content";
import { creativeFormats, learningFeatures } from "@money-maker/core/content/content";
import { z } from "zod";
import { youtubePublishSpecV1Schema } from "../../schemas/youtube-publish-spec.js";
import type { McpDependencies, ToolErrorCode, ToolResult } from "../server.js";

const identifier = z.string().trim().min(1).max(200);

export const createContentVariantInputSchema = z
  .object({
    workspaceId: z.uuid(),
    contentItemId: identifier,
    channelId: identifier,
    offerSnapshotId: identifier.optional(),
    marketplaceLabel: z
      .string()
      .regex(/^[a-z0-9_-]{1,30}$/)
      .optional()
      .describe(
        "Name of an existing Mercado Livre label already associated with this affiliate URL. Money Maker records the label for reporting; it does not create labels. Reuse labels because Mercado Livre allows at most 100 and does not allow deletion.",
      ),
    assetIds: z.array(identifier).max(35),
    caption: z
      .string()
      .trim()
      .min(1)
      .max(5_000)
      .describe(
        "Final caption. Write {link} where a clickable link belongs (Threads); the server replaces it with the official Mercado Livre affiliate URL.",
      ),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    design: z
      .object({
        canvaDesignId: z.string().trim().min(1).max(200),
        // Same bounds as sync_canva_design; pages also match assetIds (max 35).
        pages: z.array(z.number().int().positive()).min(1).max(35),
        width: z.number().int().min(1).max(4096),
        height: z.number().int().min(1).max(4096),
      })
      .strict()
      .optional()
      .describe(
        "Canva design the assets were exported from (same designId, pages, width, height passed to sync_canva_design). Lets a later sync or pending review find the design.",
      ),
    creativeFeatures: z
      .object({
        hookMove: z.enum(["curiosity_gap", "bold_claim", "contrast", "proof_first"]),
        angle: z.string().trim().min(1).max(80),
        proofType: z.enum(["rating", "sold_count", "discount", "buyer_quote", "spec", "none"]),
        urgency: z.enum(["none", "durable", "scarcity"]),
        priceShown: z.boolean(),
        discountShown: z.boolean(),
        ratingShown: z.boolean(),
        experiment: z
          .object({
            key: z.string().trim().min(1).max(64),
            arm: z.string().trim().min(1).max(32),
            feature: z.enum(learningFeatures),
          })
          .strict()
          .optional()
          .describe(
            "Experiment arm: items sharing key differ only in the declared feature (same offer or niche, channel kind and language).",
          ),
        format: z.enum(creativeFormats).optional(),
        durationSec: z.number().positive().max(7200).optional(),
      })
      .strict()
      .optional()
      .describe(
        "The creative choices of this post (hook move, angle in a few words, main proof, urgency kind, what the slides and caption show), so get_performance_summary can compare posts by choice.",
      ),
    voiceScript: z
      .array(z.string().trim().min(1).max(200))
      .max(10)
      .optional()
      .describe(
        "Reel narration, one spoken sentence per slide in slide order (instagram_carousel only). Plain speech: no hashtags, no {link}, numbers only from the offer facts, a price only with its verification date. Empty or absent renders the Reel with music only.",
      ),
    publishSpec: youtubePublishSpecV1Schema.optional(),
  })
  .strict()
  .describe("Create a validated, workspace-owned content draft for one publication channel.");

export const createContentVariantTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createContentVariantInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (parsed.data.design && parsed.data.design.pages.length !== parsed.data.assetIds.length) {
    return { ok: false, error: "INVALID_ARGUMENTS" };
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
    !dependencies.assetRepository ||
    !dependencies.providerConnections
  ) {
    throw new Error("Content dependencies are not configured.");
  }

  const contentItem = await dependencies.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: parsed.data.contentItemId,
  });
  const channel = await dependencies.channelRepository.findForWorkspace({
    workspaceId,
    channelId: parsed.data.channelId,
  });
  if (!contentItem || !channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (channel.kind !== "youtube" && !isPublishableChannelKind(channel.kind))
    return { ok: false, error: "CHANNEL_UNSUPPORTED" };
  const existingCreativeVariant = (
    await dependencies.contentRepository.listVariantsForWorkspace(workspaceId)
  ).find(
    (candidate) =>
      candidate.contentItemId === contentItem.id &&
      candidate.channelId === channel.id &&
      candidate.creativeRender !== undefined &&
      candidate.state !== "cancelled",
  );
  let filledFormat: (typeof creativeFormats)[number] | undefined =
    channel.kind === "instagram_carousel" ? "carousel" : undefined;
  let filledDurationSec: number | undefined;
  // A Reel or TikTok video must come from this post's own carousel, so it can never ship
  // another product.
  if (channel.kind === "instagram_reels" || channel.kind === "tiktok_video") {
    for (const assetId of parsed.data.assetIds) {
      const asset = await dependencies.assetRepository.findForWorkspace({ workspaceId, assetId });
      if (
        asset?.metadata?.role === "owned_clip" &&
        asset.metadata.renderStatus === "ready" &&
        isVerticalLayout(asset.metadata.layout) &&
        asset.metadata.derivedContentItemId === contentItem.id
      ) {
        filledFormat = "owned_clip";
        continue;
      }
      if (!dependencies.reelRenders)
        throw new Error("Reel render dependencies are not configured.");
      const render = await dependencies.reelRenders.findByAssetForWorkspace({
        workspaceId,
        assetId,
      });
      const source = render
        ? await dependencies.contentRepository.findVariantForWorkspace({
            workspaceId,
            variantId: render.sourceVariantId,
          })
        : null;
      if (source?.contentItemId !== contentItem.id) {
        return { ok: false, error: "REEL_SOURCE_MISMATCH" };
      }
      filledFormat = "reel_slides";
      if (render?.durationMs) filledDurationSec = Math.round(render.durationMs / 100) / 10;
    }
  }
  const experiment = parsed.data.creativeFeatures?.experiment;
  if (experiment) {
    const siblings = (
      await dependencies.contentRepository.listVariantsForWorkspace(workspaceId)
    ).filter(
      (other) =>
        other.creativeFeatures?.experiment?.key === experiment.key &&
        other.contentItemId !== contentItem.id &&
        other.state !== "cancelled",
    );
    const topic = (itemValue: { offerId: string | null; nicheId: string }) =>
      itemValue.offerId ?? `niche:${itemValue.nicheId}`;
    for (const other of siblings) {
      const [otherItem, otherChannel] = await Promise.all([
        dependencies.contentRepository.findContentItemForWorkspace({
          workspaceId,
          contentItemId: other.contentItemId,
        }),
        dependencies.channelRepository.findForWorkspace({
          workspaceId,
          channelId: other.channelId,
        }),
      ]);
      if (otherChannel && otherChannel.kind !== channel.kind) continue;
      if (
        !otherItem ||
        !otherChannel ||
        other.creativeFeatures?.experiment?.feature !== experiment.feature ||
        other.language !== parsed.data.language ||
        topic(otherItem) !== topic(contentItem)
      )
        return { ok: false, error: "EXPERIMENT_ARM_MISMATCH" };
    }
  }
  const offer =
    contentItem.offerId && dependencies.offerRepository
      ? await dependencies.offerRepository.findForWorkspace({
          workspaceId,
          offerId: contentItem.offerId,
        })
      : null;
  const connection = await dependencies.providerConnections.findForWorkspace({
    workspaceId,
    connectionId: channel.connectionId,
  });
  if (!connection) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (channel.kind === "youtube" && !parsed.data.publishSpec)
    return { ok: false, error: "PUBLISH_SPEC_MISSING" };
  if (channel.kind !== "youtube" && parsed.data.publishSpec)
    return { ok: false, error: "PUBLISH_SPEC_INVALID" };
  let affiliateUrl: URL | null = null;
  if (contentItem.offerId) {
    if (!offer) return { ok: false, error: "CONTENT_NOT_FOUND" };
    const destination = commerceDestinationFor(channel.kind, offer.marketplace);
    if (destination === "unsupported") {
      return { ok: false, error: "COMMERCE_DESTINATION_UNSUPPORTED" };
    }
    if (
      destination === "profile_link" &&
      (parsed.data.caption.includes("{link}") || captionHasLinkForTikTok(parsed.data.caption))
    ) {
      return { ok: false, error: "CAPTION_LINK_NOT_ALLOWED" };
    }
    if (offer.marketplace === "mercado_livre") {
      try {
        if (!offer.affiliateUrl) return { ok: false, error: "AFFILIATE_URL_INVALID" };
        affiliateUrl = new URL(offer.affiliateUrl);
      } catch {
        return { ok: false, error: "AFFILIATE_URL_INVALID" };
      }
      if (!isMercadoLivreAffiliateUrl(affiliateUrl))
        return { ok: false, error: "AFFILIATE_URL_INVALID" };
    }
  } else if (parsed.data.offerSnapshotId) {
    return { ok: false, error: "OFFER_UNEXPECTED" };
  } else if (parsed.data.caption.includes("{link}")) {
    return { ok: false, error: "LINK_PLACEHOLDER_WITHOUT_OFFER" };
  }
  if (parsed.data.marketplaceLabel && offer?.marketplace !== "mercado_livre")
    return { ok: false, error: "INVALID_ARGUMENTS" };
  if (
    parsed.data.marketplaceLabel &&
    (!dependencies.attributionRepository || !dependencies.publicApiUrl)
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  // The caller may pass the item's snapshot or the offer's active one (a refresh rotates it).
  if (
    parsed.data.offerSnapshotId !== undefined &&
    parsed.data.offerSnapshotId !== contentItem.offerSnapshotId &&
    parsed.data.offerSnapshotId !== offer?.activeSnapshotId
  ) {
    return { ok: false, error: "INVALID_CONTENT" };
  }
  if (
    offer &&
    contentItem.offerSnapshotId &&
    !snapshotStillBacksContent(offer, contentItem.offerSnapshotId, contentItem.sourceFactKeys)
  ) {
    return { ok: false, error: "OFFER_FACTS_CHANGED" };
  }
  // A creative build creates the channel variant before its caption is ready. Reuse that row
  // when the operator supplies the caption so the render job and caption share one variant.
  const assetIds = existingCreativeVariant?.assetIds ?? parsed.data.assetIds;
  const assets = await Promise.all(
    assetIds.map((assetId) =>
      dependencies.assetRepository?.findForWorkspace({ workspaceId, assetId }),
    ),
  );
  if (assets.some((asset) => asset === null || asset === undefined)) {
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  }
  const thumbnail = parsed.data.publishSpec?.thumbnailAssetId
    ? await dependencies.assetRepository.findForWorkspace({
        workspaceId,
        assetId: parsed.data.publishSpec.thumbnailAssetId,
      })
    : null;
  const voiceScriptErrors: Record<string, ToolErrorCode> = {
    voice_script_unsupported: "VOICE_SCRIPT_UNSUPPORTED",
    voice_script_length_mismatch: "VOICE_SCRIPT_LENGTH_MISMATCH",
    voice_script_item_invalid: "VOICE_SCRIPT_ITEM_INVALID",
  };
  let draft: ReturnType<typeof createVariant>;
  try {
    draft = createVariant({
      workspaceId,
      contentItem,
      channel,
      ...(offer ? { offer } : {}),
      assetIds,
      caption: parsed.data.caption,
      language: parsed.data.language,
      ...(existingCreativeVariant?.design
        ? { design: existingCreativeVariant.design }
        : parsed.data.design
          ? { design: parsed.data.design }
          : {}),
      ...(parsed.data.creativeFeatures
        ? {
            creativeFeatures: {
              ...parsed.data.creativeFeatures,
              ...(parsed.data.creativeFeatures.format || !filledFormat
                ? {}
                : { format: filledFormat }),
              ...(parsed.data.creativeFeatures.durationSec === undefined &&
              filledDurationSec !== undefined
                ? { durationSec: filledDurationSec }
                : {}),
            },
          }
        : {}),
      ...(parsed.data.voiceScript ? { voiceScript: parsed.data.voiceScript } : {}),
      ...(parsed.data.publishSpec ? { publishSpec: parsed.data.publishSpec } : {}),
    });
  } catch (error) {
    const code = error instanceof Error ? voiceScriptErrors[error.message] : undefined;
    if (code) return { ok: false, error: code };
    throw error;
  }
  const variant = {
    ...draft,
    ...(existingCreativeVariant
      ? { id: existingCreativeVariant.id, creativeRender: existingCreativeVariant.creativeRender }
      : {}),
    caption: affiliateUrl
      ? withOfficialLink(draft.caption, affiliateUrl.toString(), dependencies.publicApiUrl)
      : draft.caption,
  };
  const review = validateVariantForReview(variant, {
    channel,
    connectionStatus: connection.status,
    ...(offer ? { offer } : {}),
    assets: assets.filter(
      (asset): asset is NonNullable<typeof asset> => asset !== null && asset !== undefined,
    ),
    sourceFactKeys: contentItem.sourceFactKeys,
    ...(thumbnail ? { thumbnail } : {}),
  });
  if (
    !review.ok &&
    !(
      existingCreativeVariant?.creativeRender?.state === "pending" &&
      review.code === "asset_sequence_invalid"
    )
  ) {
    if (review.code === "publish_spec_missing") return { ok: false, error: "PUBLISH_SPEC_MISSING" };
    if (review.code === "publish_spec_unexpected" || review.code === "publish_spec_invalid")
      return { ok: false, error: "PUBLISH_SPEC_INVALID" };
    if (review.code === "asset_duration_unknown")
      return { ok: false, error: "ASSET_DURATION_UNKNOWN" };
    if (review.code === "short_format_invalid") return { ok: false, error: "SHORT_FORMAT_INVALID" };
    if (review.code === "thumbnail_invalid") return { ok: false, error: "THUMBNAIL_INVALID" };
    return { ok: false, error: "INVALID_CONTENT" };
  }
  let trackedVariant = variant;
  if (affiliateUrl && dependencies.attributionRepository && dependencies.publicApiUrl) {
    const destination = affiliateUrl.toString();
    const expectedFingerprint = destinationFingerprint(destination);
    const existingLink = dependencies.attributionRepository.findForVariant
      ? await dependencies.attributionRepository.findForVariant({
          workspaceId,
          contentVariantId: variant.id,
        })
      : null;
    const reuseLink =
      existingLink?.destinationFingerprint === expectedFingerprint &&
      (parsed.data.marketplaceLabel === undefined ||
        parsed.data.marketplaceLabel === existingLink.marketplaceLabel);
    const marketplaceLabel = parsed.data.marketplaceLabel ?? existingLink?.marketplaceLabel;
    const redirect = reuseLink
      ? existingLink
      : await dependencies.attributionRepository.createRedirect(
          createRedirect({
            workspaceId,
            destination: affiliateUrl,
            expiresAt: new Date(Date.now() + TRACKED_LINK_TTL_MS),
            contentVariantId: variant.id,
            ...(offer ? { offerId: offer.id } : {}),
            ...(offer ? { fallback: new URL(offer.listingUrl) } : {}),
            ...(marketplaceLabel ? { marketplaceLabel } : {}),
          }),
        );
    trackedVariant = {
      ...variant,
      caption: withOfficialLink(
        draft.caption,
        trackedUrl(dependencies.publicApiUrl, redirect.slug),
        dependencies.publicApiUrl,
      ),
    };
    const trackedReview = validateVariantForReview(trackedVariant, {
      channel,
      connectionStatus: connection.status,
      ...(offer ? { offer } : {}),
      assets: assets.filter(
        (asset): asset is NonNullable<typeof asset> => asset !== null && asset !== undefined,
      ),
      sourceFactKeys: contentItem.sourceFactKeys,
      ...(thumbnail ? { thumbnail } : {}),
    });
    if (!trackedReview.ok) {
      return { ok: false, error: "INVALID_CONTENT" };
    }
  }
  const savedVariant = existingCreativeVariant
    ? await dependencies.contentRepository.updateVariant(trackedVariant)
    : await dependencies.contentRepository.createVariant(trackedVariant);
  return {
    ok: true,
    value: {
      variant: savedVariant,
    },
  };
};
