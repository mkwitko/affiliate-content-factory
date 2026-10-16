import type { WorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import type { Channel } from "../channels/channel.js";
import type { YouTubePublishSpecV1 } from "../channels/youtube-publish-spec.js";
import { validateYouTubeVariant } from "../channels/youtube-validation.js";
import type { CreativeFidelity } from "../creatives/product-fidelity.js";
import type { QualityVerdict } from "../creatives/slide-quality.js";
import type { SlideSpec } from "../creatives/slide-spec.js";
import type { Offer } from "../offers/offer.js";
import type { ProviderConnectionStatus } from "../providers/provider-connection.js";

export type ContentItemState = "draft" | "cancelled";
export type VariantState =
  | "draft"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "scheduled"
  | "published"
  | "cancelled";

export type VariantApproval = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  variantId: string;
  actorId: string;
  assetChecksums: readonly string[];
  offerSnapshotId: string | null;
  publicationFingerprint: string | null;
  policyVersion: number;
  decidedAt: Date;
}>;

export type ContentItem = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  offerId: string | null;
  offerSnapshotId: string | null;
  sourceContentItemId?: string;
  title: string;
  sourceFactKeys: readonly string[];
  sourcePictureAssetIds?: readonly string[];
  creativeSlides?: readonly SlideSpec[];
  creativeOpinion: string;
  state: ContentItemState;
}>;

export type VariantDesign = Readonly<{
  canvaDesignId: string;
  pages: readonly number[];
  width: number;
  height: number;
}>;

/**
 * Creative choices recorded when the post is made, so performance can later be compared by
 * choice without asking a model to re-read old captions. Creative opinion, never a fact.
 */
export const creativeFormats = [
  "carousel",
  "reel_slides",
  "stickman_explainer",
  "owned_clip",
  "ai_story",
] as const;
export type CreativeFormat = (typeof creativeFormats)[number];
export const learningFeatures = [
  "hookMove",
  "angle",
  "proofType",
  "urgency",
  "priceShown",
  "format",
  "durationBand",
  "publishHour",
  "layoutFamily",
  "productMode",
  "headlineLength",
  "ctaKind",
] as const;
export type LearningFeature = (typeof learningFeatures)[number];
export type ExperimentArm = Readonly<{ key: string; arm: string; feature: LearningFeature }>;

export type CreativeFeatures = Readonly<{
  experiment?: ExperimentArm | undefined;
  format?: CreativeFormat | undefined;
  durationSec?: number | undefined;
  /** Operator judgement; automatic derivation cannot know it, so stored JSON may lack these four. */
  hookMove?: "curiosity_gap" | "bold_claim" | "contrast" | "proof_first" | undefined;
  angle?: string | undefined;
  proofType?: "rating" | "sold_count" | "discount" | "buyer_quote" | "spec" | "none" | undefined;
  urgency?: "none" | "durable" | "scarcity" | undefined;
  priceShown: boolean;
  discountShown: boolean;
  ratingShown: boolean;
  /** Derived from the stored CreativeDocument after render. */
  layoutFamily?: string | undefined;
  productMode?: string | undefined;
  ctaKind?: string | undefined;
  /** Derived from the cover headline: short <=25, medium <=45, long above. */
  headlineLength?: "short" | "medium" | "long" | undefined;
}>;

export type ContentVariant = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  contentItemId: string;
  channelId: string;
  offerSnapshotId: string | null;
  assetIds: readonly string[];
  caption: string;
  language: string;
  design?: VariantDesign;
  creativeFeatures?: CreativeFeatures;
  creativeRender?: Readonly<{
    state: "pending" | "rendered" | "failed";
    reason?: string;
    templateVersions: Readonly<Record<string, number>>;
    rendererVersion: number;
    brandKitHash: string;
    /** Product fidelity per persisted slide; block refuses approval, warn needs a human look. */
    fidelity?: CreativeFidelity;
    /** Legibility QA per in-scene slide; block refuses approval. */
    quality?: Readonly<{
      verdict: QualityVerdict;
      slides: readonly Readonly<{ slideIndex: number; verdict: QualityVerdict; score: number }>[];
      /** QA of the whole carousel (sequence-quality.ts); folded into `verdict`. */
      sequence?: Readonly<{ verdict: QualityVerdict; reasons: readonly string[] }>;
    }>;
  }>;
  state: VariantState;
  approval?: VariantApproval;
  rejectionReason?: string;
  voiceScript: readonly string[];
  publishSpec?: YouTubePublishSpecV1;
}>;

export type CreateContentItemInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  offer?: Offer;
  sourceContentItemId?: string;
  title: string;
  sourceFactKeys: readonly string[];
  sourcePictureAssetIds?: readonly string[];
  creativeSlides?: readonly SlideSpec[];
  creativeOpinion: string;
}>;

export type CreateVariantInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  contentItem: ContentItem;
  channel: Channel;
  offer?: Offer;
  assetIds: readonly string[];
  caption: string;
  language: string;
  design?: VariantDesign;
  creativeFeatures?: CreativeFeatures;
  voiceScript?: readonly string[];
  publishSpec?: YouTubePublishSpecV1;
}>;

export type VariantReviewResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "workspace_mismatch"
        | "connection_inactive"
        | "channel_inactive"
        | "offer_required"
        | "offer_unexpected"
        | "offer_not_active"
        | "offer_snapshot_invalid"
        | "asset_sequence_invalid"
        | "asset_count_invalid"
        | "asset_unavailable"
        | "unsupported_asset"
        | "asset_dimensions_invalid"
        | "caption_too_long"
        | "language_invalid"
        | "publish_spec_missing"
        | "publish_spec_unexpected"
        | "publish_spec_invalid"
        | "asset_duration_unknown"
        | "short_format_invalid"
        | "thumbnail_invalid";
    }>;

export const voiceScriptItemMaxLength = 200;

/** Returns the offending reason or null. Pure; used by createVariant and the API schema test. */
export const voiceScriptItemProblem = (
  item: string,
): "empty" | "too_long" | "hashtag" | "link_placeholder" | "no_letters" | null => {
  const text = item.trim();
  if (text.length === 0) return "empty";
  if (text.length > voiceScriptItemMaxLength) return "too_long";
  if (/(^|\s)#\S/.test(text)) return "hashtag";
  if (text.includes("{link}")) return "link_placeholder";
  if (!/\p{L}/u.test(text)) return "no_letters";
  return null;
};

const requireText = (value: string, message: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(message);
  return trimmed;
};

const activeSnapshot = (offer: Offer) => {
  if (offer.state !== "active") throw new Error("Active offer is required");
  if (!offer.activeSnapshotId) throw new Error("Active offer snapshot is required");
  const snapshot = offer.snapshots.find((candidate) => candidate.id === offer.activeSnapshotId);
  if (!snapshot) throw new Error("Active offer snapshot is missing");
  return snapshot;
};

export const createContentItem = (input: CreateContentItemInput): ContentItem => {
  if (input.sourceContentItemId && input.sourceContentItemId === input.id)
    throw new Error("content_item_source_invalid");
  if (input.offer && input.offer.workspaceId !== input.workspaceId) {
    throw new Error("Offer belongs to another workspace");
  }
  if (!input.offer && input.sourceFactKeys.length > 0) {
    throw new Error("Content fact keys require an offer");
  }
  if (!input.offer && input.sourcePictureAssetIds?.length) {
    throw new Error("Source pictures require an offer");
  }
  const snapshot = input.offer ? activeSnapshot(input.offer) : null;
  const factKeys = Object.freeze(
    input.sourceFactKeys.map((key) => requireText(key, "Content fact key is required")),
  );
  if (new Set(factKeys).size !== factKeys.length)
    throw new Error("Content fact keys must be unique");
  const availableFactKeys = new Set(snapshot?.facts.map((fact) => fact.key) ?? []);
  if (factKeys.some((key) => !availableFactKeys.has(key))) {
    throw new Error("Content fact is not present in the offer snapshot");
  }
  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    nicheId: requireText(input.nicheId, "Content niche is required"),
    offerId: input.offer?.id ?? null,
    offerSnapshotId: snapshot?.id ?? null,
    ...(input.sourceContentItemId ? { sourceContentItemId: input.sourceContentItemId } : {}),
    title: requireText(input.title, "Content title is required"),
    sourceFactKeys: factKeys,
    ...(input.sourcePictureAssetIds?.length
      ? { sourcePictureAssetIds: Object.freeze([...new Set(input.sourcePictureAssetIds)]) }
      : {}),
    ...(input.creativeSlides ? { creativeSlides: Object.freeze([...input.creativeSlides]) } : {}),
    creativeOpinion: requireText(input.creativeOpinion, "Creative opinion is required"),
    state: "draft" as const,
  });
};

/**
 * The offer refresh activates a new snapshot every few hours, even when nothing changed. Content
 * built on an older snapshot stays valid while every fact it cites, and availability, still match.
 */
export const snapshotStillBacksContent = (
  offer: Offer,
  snapshotId: string,
  sourceFactKeys: readonly string[],
): boolean => {
  if (offer.activeSnapshotId === snapshotId) return true;
  const active = offer.snapshots.find((snapshot) => snapshot.id === offer.activeSnapshotId);
  const cited = offer.snapshots.find((snapshot) => snapshot.id === snapshotId);
  if (!active || !cited) return false;
  const factValue = (snapshot: typeof active, key: string) =>
    JSON.stringify(snapshot.facts.find((fact) => fact.key === key)?.value ?? null);
  return [...sourceFactKeys, "availability"].every(
    (key) => factValue(active, key) === factValue(cited, key),
  );
};

export const createVariant = (input: CreateVariantInput): ContentVariant => {
  if (
    input.contentItem.workspaceId !== input.workspaceId ||
    input.channel.workspaceId !== input.workspaceId ||
    (input.offer && input.offer.workspaceId !== input.workspaceId)
  ) {
    throw new Error("Content variant resources must share a workspace");
  }
  if (input.contentItem.offerId !== null && !input.offer) {
    throw new Error("offer_required");
  }
  if (input.contentItem.offerId === null && input.offer) {
    throw new Error("offer_unexpected");
  }
  if (input.offer && input.contentItem.offerId !== input.offer.id) {
    throw new Error("Content variant offer does not match content item");
  }
  if (
    input.offer &&
    !snapshotStillBacksContent(
      input.offer,
      input.contentItem.offerSnapshotId ?? "",
      input.contentItem.sourceFactKeys,
    )
  ) {
    throw new Error("Content variant offer snapshot does not match content item");
  }
  if (input.contentItem.offerId === null && input.caption.includes("{link}")) {
    throw new Error("LINK_PLACEHOLDER_WITHOUT_OFFER");
  }
  const language = requireText(input.language, "Content language is required");
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new Error("Content language is invalid");
  const design = input.design
    ? Object.freeze({
        canvaDesignId: requireText(input.design.canvaDesignId, "Canva design id is required"),
        pages: Object.freeze([...input.design.pages]),
        width: input.design.width,
        height: input.design.height,
      })
    : undefined;
  if (design && design.pages.length !== input.assetIds.length) {
    throw new Error("Design pages must match the asset sequence");
  }
  const voiceScript = (input.voiceScript ?? []).map((item) => item.trim());
  if (voiceScript.length > 0) {
    if (input.channel.kind !== "instagram_carousel") throw new Error("voice_script_unsupported");
    if (voiceScript.length !== input.assetIds.length) {
      throw new Error("voice_script_length_mismatch");
    }
    if (voiceScript.some((item) => voiceScriptItemProblem(item) !== null)) {
      throw new Error("voice_script_item_invalid");
    }
  }
  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    contentItemId: input.contentItem.id,
    channelId: input.channel.id,
    offerSnapshotId: input.contentItem.offerSnapshotId,
    assetIds: Object.freeze([...input.assetIds]),
    caption: requireText(input.caption, "Content caption is required"),
    language,
    ...(design ? { design } : {}),
    ...(input.creativeFeatures
      ? { creativeFeatures: Object.freeze({ ...input.creativeFeatures }) }
      : {}),
    state: "draft" as const,
    voiceScript: Object.freeze(voiceScript),
    ...(input.publishSpec
      ? {
          publishSpec: Object.freeze({
            ...input.publishSpec,
            ...(input.publishSpec.tags ? { tags: Object.freeze([...input.publishSpec.tags]) } : {}),
          }),
        }
      : {}),
  });
};

export const validateVariantForReview = (
  variant: ContentVariant,
  context: Readonly<{
    channel: Channel;
    connectionStatus: ProviderConnectionStatus;
    offer?: Offer;
    assets: readonly Asset[];
    thumbnail?: Asset | null;
    /** The content item's cited fact keys, so a refreshed but unchanged snapshot still passes. */
    sourceFactKeys: readonly string[];
  }>,
): VariantReviewResult => {
  if (
    variant.workspaceId !== context.channel.workspaceId ||
    (context.offer && variant.workspaceId !== context.offer.workspaceId)
  ) {
    return { ok: false, code: "workspace_mismatch" };
  }
  if (context.connectionStatus !== "active") return { ok: false, code: "connection_inactive" };
  if (context.channel.status !== "active") return { ok: false, code: "channel_inactive" };
  if (variant.offerSnapshotId === null && context.offer)
    return { ok: false, code: "offer_unexpected" };
  if (variant.offerSnapshotId !== null && !context.offer)
    return { ok: false, code: "offer_required" };
  if (context.offer && context.offer.state !== "active")
    return { ok: false, code: "offer_not_active" };
  if (
    context.offer &&
    !snapshotStillBacksContent(context.offer, variant.offerSnapshotId ?? "", context.sourceFactKeys)
  ) {
    return { ok: false, code: "offer_snapshot_invalid" };
  }
  if (variant.assetIds.length > context.channel.capabilities.maxAssets) {
    return { ok: false, code: "asset_count_invalid" };
  }
  if (variant.assetIds.length === 0 && context.channel.kind !== "threads") {
    return { ok: false, code: "asset_sequence_invalid" };
  }
  const assetsById = new Map(context.assets.map((asset) => [asset.id, asset]));
  if (variant.assetIds.some((assetId) => !assetsById.has(assetId))) {
    return { ok: false, code: "asset_sequence_invalid" };
  }
  const assets = variant.assetIds.map((assetId) => assetsById.get(assetId));
  if (assets.some((asset) => asset?.workspaceId !== variant.workspaceId)) {
    return { ok: false, code: "workspace_mismatch" };
  }
  if (assets.some((asset) => asset?.state !== "active")) {
    return { ok: false, code: "asset_unavailable" };
  }
  if (
    assets.some(
      (asset) =>
        asset !== undefined &&
        !context.channel.capabilities.allowedMimeTypes.includes(asset.mimeType),
    )
  ) {
    return { ok: false, code: "unsupported_asset" };
  }
  const requiredDimensions = context.channel.capabilities.requiredAssetDimensions;
  if (
    requiredDimensions &&
    assets.some(
      (asset) =>
        asset !== undefined &&
        (asset.width !== requiredDimensions.width || asset.height !== requiredDimensions.height),
    )
  ) {
    return { ok: false, code: "asset_dimensions_invalid" };
  }
  if (variant.caption.length > context.channel.capabilities.captionMaxLength) {
    return { ok: false, code: "caption_too_long" };
  }
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(variant.language)) {
    return { ok: false, code: "language_invalid" };
  }
  if (context.channel.kind !== "youtube" && variant.publishSpec)
    return { ok: false, code: "publish_spec_unexpected" };
  if (context.channel.kind === "youtube") {
    const problem = validateYouTubeVariant({
      spec: variant.publishSpec,
      asset: assets[0],
      thumbnail: context.thumbnail ?? undefined,
      assetIds: variant.assetIds,
      workspaceId: variant.workspaceId,
      caption: variant.caption,
    });
    if (problem) return { ok: false, code: problem };
  }
  return { ok: true };
};
