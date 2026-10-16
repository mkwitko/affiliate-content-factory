import type { Asset } from "../assets/asset.js";
import type { YouTubePublishSpecV1 } from "./youtube-publish-spec.js";

export type YouTubeVariantProblem =
  | "publish_spec_missing"
  | "publish_spec_unexpected"
  | "publish_spec_invalid"
  | "asset_duration_unknown"
  | "short_format_invalid"
  | "thumbnail_invalid"
  | "caption_too_long";

export const validateYouTubeVariant = (input: {
  spec: YouTubePublishSpecV1 | undefined;
  asset: Asset | undefined;
  thumbnail: Asset | undefined;
  assetIds: readonly string[];
  workspaceId: string;
  caption: string;
}): YouTubeVariantProblem | null => {
  const { spec, asset, thumbnail } = input;
  if (!spec) return "publish_spec_missing";
  if (
    spec.schemaVersion !== 1 ||
    !spec.title.trim() ||
    spec.title.length > 100 ||
    !["long_form", "short"].includes(spec.intendedFormat) ||
    !["private", "unlisted"].includes(spec.privacyStatus) ||
    typeof spec.madeForKids !== "boolean" ||
    typeof spec.containsSyntheticMedia !== "boolean" ||
    (spec.tags !== undefined &&
      (spec.tags.some((tag) => !tag.trim()) || spec.tags.join(",").length > 500)) ||
    (spec.categoryId !== undefined && !/^\d+$/.test(spec.categoryId)) ||
    (spec.defaultLanguage !== undefined &&
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(spec.defaultLanguage)) ||
    (spec.containsSyntheticMedia && !spec.disclosureReason?.trim())
  )
    return "publish_spec_invalid";
  if (
    !asset ||
    asset.mimeType !== "video/mp4" ||
    asset.state !== "active" ||
    asset.workspaceId !== input.workspaceId
  )
    return "publish_spec_invalid";
  if (!asset.durationMs || asset.durationMs <= 0) return "asset_duration_unknown";
  if (new TextEncoder().encode(input.caption).byteLength > 5000) return "caption_too_long";
  if (spec.intendedFormat === "short" && (asset.durationMs > 180_000 || asset.height < asset.width))
    return "short_format_invalid";
  if (spec.thumbnailAssetId) {
    if (
      input.assetIds.includes(spec.thumbnailAssetId) ||
      !thumbnail ||
      thumbnail.id !== spec.thumbnailAssetId ||
      thumbnail.workspaceId !== input.workspaceId ||
      thumbnail.state !== "active" ||
      !["image/jpeg", "image/png"].includes(thumbnail.mimeType)
    )
      return "thumbnail_invalid";
  }
  return null;
};

export const youtubeThumbnailIsRecommended = (asset: Asset): boolean =>
  asset.width === 1280 && asset.height === 720 && (asset.byteSize ?? Infinity) <= 2_000_000;
