import type { PostMetrics } from "../analytics/performance.js";
import type { YouTubePublishSpecV1 } from "../channels/youtube-publish-spec.js";
export type SocialPublishInput = Readonly<{
  secretReference: string;
  accountId: string;
  /** "tiktok" is always sent as a draft to the TikTok app inbox; the operator posts it there. */
  platform: "instagram" | "threads" | "youtube" | "tiktok";
  text: string;
  mediaUrls?: readonly string[];
  idempotencyKey: string;
  /** Connection display name; adapters resolve non-Instagram accounts by matching it. */
  accountHandle?: string;
  /** Where the post lands on the platform; defaults to "timeline" (e.g. an Instagram Story
   *  channel sets "stories", an Instagram Reels channel sets "reels", so it isn't published
   *  as a feed post). */
  placement?: "timeline" | "stories" | "reels";
  youtube?: Readonly<{ spec: YouTubePublishSpecV1; thumbnailUrl?: string }>;
}>;

export type SocialPublishResult = Readonly<{
  externalId: string;
  status: "queued" | "published" | "failed";
  /** Set when status is "failed"; a short provider error message. */
  failureReason?: string;
}>;

export type SocialReconcileInput = Readonly<{
  secretReference: string;
  accountId: string;
  externalId: string;
}>;

export interface SocialPublisher {
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
  reconcile(input: SocialReconcileInput): Promise<SocialPublishResult>;
  /** Lifetime metrics of a published post; null when the provider has none for it. */
  readMetrics?(
    input: SocialReconcileInput,
  ): Promise<{ metrics: PostMetrics; platformUrl?: string } | null>;
}
