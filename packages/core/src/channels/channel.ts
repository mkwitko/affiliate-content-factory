import type { WorkspaceId } from "@money-maker/contracts";
import type { ProviderConnection } from "../providers/provider-connection.js";

export type ChannelKind =
  | "instagram_carousel"
  | "instagram_stories"
  | "instagram_reels"
  | "threads"
  | "tiktok_photo_post"
  | "youtube"
  | "tiktok_video";

export type ChannelCapabilities = Readonly<{
  maxAssets: number;
  requiresOrderedAssets: boolean;
  allowedMimeTypes: readonly string[];
  captionMaxLength: number;
  requiredAssetDimensions?: Readonly<{ width: number; height: number }>;
}>;

export type Channel = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  connectionId: string;
  /** The niche profile this channel publishes for; automatic packages use only their niche's. */
  nicheId?: string | null;
  kind: ChannelKind;
  label: string;
  status: "active" | "inactive";
  capabilities: ChannelCapabilities;
  context?: Record<string, unknown> | null;
}>;

export type CreateChannelInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  connection: ProviderConnection;
  kind: ChannelKind;
  label?: string;
}>;

const imageMimeTypes = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

export const channelCapabilities: Readonly<Record<ChannelKind, ChannelCapabilities>> =
  Object.freeze({
    instagram_carousel: Object.freeze({
      maxAssets: 10,
      requiresOrderedAssets: true,
      allowedMimeTypes: imageMimeTypes,
      captionMaxLength: 2200,
      requiredAssetDimensions: Object.freeze({ width: 1080, height: 1350 }),
    }),
    instagram_stories: Object.freeze({
      maxAssets: 10,
      requiresOrderedAssets: true,
      allowedMimeTypes: imageMimeTypes,
      captionMaxLength: 1000,
      requiredAssetDimensions: Object.freeze({ width: 1080, height: 1920 }),
    }),
    // No AI video: the asset is rendered from an approved carousel's own slides (render_reel).
    instagram_reels: Object.freeze({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: Object.freeze(["video/mp4"]),
      captionMaxLength: 2200,
      requiredAssetDimensions: Object.freeze({ width: 1080, height: 1920 }),
    }),
    threads: Object.freeze({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: imageMimeTypes,
      captionMaxLength: 500,
    }),
    tiktok_photo_post: Object.freeze({
      maxAssets: 35,
      requiresOrderedAssets: true,
      allowedMimeTypes: imageMimeTypes,
      captionMaxLength: 4000,
      requiredAssetDimensions: Object.freeze({ width: 1080, height: 1920 }),
    }),
    youtube: Object.freeze({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: Object.freeze(["video/mp4"]),
      captionMaxLength: 5000,
    }),
    // No AI video, same rule as instagram_reels: the asset is this post's own carousel reel
    // render or its own vertical owned clip. Product attachment happens manually in the app.
    tiktok_video: Object.freeze({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: Object.freeze(["video/mp4"]),
      captionMaxLength: 2200,
      requiredAssetDimensions: Object.freeze({ width: 1080, height: 1920 }),
    }),
  });

export const createChannel = (input: CreateChannelInput): Channel => {
  if (input.connection.status !== "active") throw new Error("Connection is not active");
  if (input.connection.workspaceId !== input.workspaceId) {
    throw new Error("Connection belongs to another workspace");
  }
  if (input.kind === "youtube" && input.connection.platform !== "youtube")
    throw new Error("YouTube account connection is required");
  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    connectionId: input.connection.id,
    kind: input.kind,
    label: input.label?.trim() || input.kind,
    status: "active" as const,
    capabilities: channelCapabilities[input.kind],
  });
};

/** Kinds the Post For Me publisher maps today. Others fail at publish time. */
export const publishableChannelKinds: readonly ChannelKind[] = Object.freeze([
  "instagram_carousel",
  "instagram_stories",
  "instagram_reels",
  "threads",
  "youtube",
  "tiktok_video",
  "tiktok_photo_post",
]);

export const isPublishableChannelKind = (kind: ChannelKind): boolean =>
  publishableChannelKinds.includes(kind);

/** Channel kinds the operator may post by hand and confirm with record_manual_publication. */
export const manualPublicationChannelKinds: readonly ChannelKind[] = Object.freeze([
  "instagram_stories",
  "tiktok_video",
  "tiktok_photo_post",
]);

/** No publisher API path at all: publish_content refuses these. TikTok kinds are not here:
 *  they go to the TikTok app's drafts and the operator finishes the post there. */
export const isManualOnlyChannelKind = (kind: ChannelKind): boolean => kind === "instagram_stories";

export const isManualPublicationChannelKind = (kind: ChannelKind): boolean =>
  manualPublicationChannelKinds.includes(kind);
