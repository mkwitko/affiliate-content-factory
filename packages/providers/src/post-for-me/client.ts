import type { YouTubePublishSpecV1 } from "@money-maker/core/channels/youtube-publish-spec";

export type PostForMeResponse = Readonly<{
  status: number;
  json(): Promise<unknown>;
}>;

export type PostForMeTransport = (input: {
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
}) => Promise<PostForMeResponse>;

type PostForMePublishStatus = "queued" | "published" | "failed";

type PostForMePublishResult = Readonly<{
  externalId: string;
  status: PostForMePublishStatus;
  /** Set when status is "failed"; a short provider error message. */
  failureReason?: string;
}>;

type PostForMeRawStatus = "draft" | "scheduled" | "processing" | "processed";

export type PostForMeWebhook = Readonly<{
  id: string;
  secret: string;
}>;

// ponytail: the API doesn't document a status field on social accounts — every account it
// returns is currently connected, so every entry is mapped to "active". Add real status
// mapping if Post For Me ever starts returning disabled/expired accounts in this list.
export type PostForMeSocialAccount = Readonly<{
  id: string;
  platform: string;
  username: string;
  status: "active";
}>;

export type PostForMePlatform = "instagram" | "threads" | "youtube" | "tiktok" | "tiktok_business";

export type PostForMeClient = Readonly<{
  listSocialAccounts(apiKey: string, platform?: string): Promise<readonly PostForMeSocialAccount[]>;
  createSocialPost(input: {
    apiKey: string;
    accountId: string;
    platform: PostForMePlatform;
    text: string;
    mediaUrls?: readonly string[];
    idempotencyKey: string;
    /** Where the post lands on the platform; defaults to "timeline". */
    placement?: "timeline" | "stories" | "reels";
    youtube?: Readonly<{ spec: YouTubePublishSpecV1; thumbnailUrl?: string }>;
  }): Promise<PostForMePublishResult>;
  findSocialPostByExternalId(input: {
    apiKey: string;
    accountId: string;
    externalId: string;
  }): Promise<PostForMePublishResult>;
  createWebhook(input: {
    apiKey: string;
    url: string;
    eventTypes: readonly string[];
  }): Promise<PostForMeWebhook>;
  /** Lifetime metrics of one post from the account feed; null when the feed has no such post. */
  getSocialPostMetrics(input: {
    apiKey: string;
    accountId: string;
    socialPostId: string;
  }): Promise<PostForMePostMetrics | null>;
}>;

export type PostForMePostMetrics = Readonly<{
  metrics: Readonly<{
    views?: number;
    reach?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    profileVisits?: number;
    estimatedMinutesWatched?: number;
    averageViewDuration?: number;
    averageViewPercentage?: number;
    subscribersGained?: number;
    subscribersLost?: number;
    engagedViews?: number;
  }>;
  platformUrl?: string;
}>;

// Field names differ per platform (Instagram "saved", Threads "replies"); the first present wins.
const metricFields = {
  views: ["views", "view_count", "video_views"],
  reach: ["reach"],
  likes: ["likes", "like_count"],
  comments: ["comments", "replies", "comment_count"],
  shares: ["shares", "share_count"],
  saves: ["saved", "saves", "save"],
  profileVisits: ["profile_visits", "profile_views"],
  estimatedMinutesWatched: ["estimatedMinutesWatched", "estimated_minutes_watched"],
  averageViewDuration: ["averageViewDuration", "average_view_duration"],
  averageViewPercentage: ["averageViewPercentage", "average_view_percentage"],
  subscribersGained: ["subscribersGained", "subscribers_gained"],
  subscribersLost: ["subscribersLost", "subscribers_lost"],
  engagedViews: ["engagedViews", "engaged_views"],
} as const;

const normalizeMetrics = (
  value: unknown,
  onWarning: (
    code: "metric_unit_suspect" | "metric_value_invalid",
    field: string,
  ) => void = () => {},
): PostForMePostMetrics["metrics"] => {
  if (!isRecord(value)) return {};
  const metrics: Record<string, number> = {};
  for (const [name, fields] of Object.entries(metricFields)) {
    const found = fields.map((field) => value[field]).find((entry) => typeof entry === "number");
    if (found === undefined) continue;
    if (typeof found !== "number" || !Number.isFinite(found) || found < 0) {
      onWarning("metric_value_invalid", name);
      continue;
    }
    if (name === "averageViewPercentage" && found <= 1) onWarning("metric_unit_suspect", name);
    metrics[name] =
      name === "estimatedMinutesWatched" || name === "averageViewDuration"
        ? Math.round(found)
        : found;
  }
  return metrics;
};

const defaultTransport: PostForMeTransport = async ({ method, url, headers, body, signal }) => {
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal,
  });
  return { status: response.status, json: () => response.json() };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractExternalId = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const id = value.id ?? value.post_id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const normalizeRawStatus = (value: unknown): PostForMeRawStatus | null => {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (
    value.status === "draft" ||
    value.status === "scheduled" ||
    value.status === "processing" ||
    value.status === "processed"
  ) {
    return value.status;
  }
  return null;
};

// Provider errors are string | object | null; never surface `details` (may hold raw payloads).
const reduceFailureReason = (error: unknown): string => {
  const message =
    typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : "provider_post_failed";
  return message.slice(0, 300);
};

const responseJson = async (response: PostForMeResponse): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new Error("provider_malformed_response");
  }
};

const normalizedErrors = new Set([
  "provider_credential_expired",
  "provider_rate_limited",
  "provider_unknown_outcome",
  "provider_rejected",
  "provider_malformed_response",
  "provider_reconciliation_integrity_failure",
  "provider_network_failure",
]);

const isNormalizedError = (error: unknown): error is Error =>
  error instanceof Error && normalizedErrors.has(error.message);

// The feed is per account: social_accounts[0] is the account the post was actually sent to,
// which for a non-Instagram platform differs from whatever accountId the caller passed in.
const firstAccountId = (value: unknown): string | null => {
  if (!isRecord(value) || !Array.isArray(value.social_accounts)) return null;
  const first = value.social_accounts[0];
  if (typeof first === "string") return first;
  if (isRecord(first) && typeof first.id === "string") return first.id;
  return null;
};

export const createPostForMeClient = (input?: {
  baseUrl?: string;
  transport?: PostForMeTransport;
  timeoutMs?: number;
  onMetricWarning?: (code: "metric_unit_suspect" | "metric_value_invalid", field: string) => void;
}): PostForMeClient => {
  const baseUrl = (input?.baseUrl ?? "https://api.postforme.dev").replace(/\/$/, "");
  const transport = input?.transport ?? defaultTransport;
  const timeoutMs = input?.timeoutMs ?? 10_000;

  const sendRequest = async (requestInput: {
    apiKey: string;
    method: "GET" | "POST";
    url: string;
    body?: string;
  }): Promise<PostForMeResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await transport({
        method: requestInput.method,
        url: requestInput.url,
        headers: {
          authorization: `Bearer ${requestInput.apiKey}`,
          ...(requestInput.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(requestInput.body === undefined ? {} : { body: requestInput.body }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("provider_timeout");
      }
      if (isNormalizedError(error)) throw error;
      throw new Error("provider_network_failure");
    } finally {
      clearTimeout(timeout);
    }
  };

  const readAcceptedResponse = async (response: PostForMeResponse): Promise<unknown> => {
    if (response.status === 401 || response.status === 403) {
      throw new Error("provider_credential_expired");
    }
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (response.status >= 500) throw new Error("provider_unknown_outcome");
    if (response.status < 200 || response.status >= 300) {
      throw new Error("provider_rejected");
    }
    return responseJson(response);
  };

  // A "processed" post is terminal at the provider but still per-account: fetch that
  // account's result to learn whether it actually posted.
  const resolvePublishResult = async (input: {
    apiKey: string;
    externalId: string;
    accountId: string;
    rawStatus: PostForMeRawStatus;
  }): Promise<PostForMePublishResult> => {
    if (input.rawStatus !== "processed") {
      return { externalId: input.externalId, status: "queued" };
    }
    const url = new URL(`${baseUrl}/v1/social-post-results`);
    url.searchParams.set("post_id", input.externalId);
    url.searchParams.set("social_account_id", input.accountId);
    const response = await sendRequest({
      apiKey: input.apiKey,
      method: "GET",
      url: url.toString(),
    });
    const payload = await readAcceptedResponse(response);
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("provider_malformed_response");
    }
    const result = payload.data.find(
      (item) => isRecord(item) && item.social_account_id === input.accountId,
    );
    if (!isRecord(result)) return { externalId: input.externalId, status: "queued" };
    if (result.success === true) return { externalId: input.externalId, status: "published" };
    if (result.success === false) {
      return {
        externalId: input.externalId,
        status: "failed",
        failureReason: reduceFailureReason(result.error),
      };
    }
    return { externalId: input.externalId, status: "queued" };
  };

  return {
    async listSocialAccounts(apiKey, platform = "instagram") {
      const response = await sendRequest({
        apiKey,
        method: "GET",
        // The API documents no pagination; filtering by platform keeps the list small.
        url: `${baseUrl}/v1/social-accounts?platform=${encodeURIComponent(platform)}`,
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error("invalid_api_key");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error("provider_rejected");
      }
      const payload = await responseJson(response);
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error("provider_malformed_response");
      }
      return payload.data.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.platform !== "string" ||
          typeof item.username !== "string"
        ) {
          return [];
        }
        return [
          {
            id: item.id,
            platform: item.platform,
            username: item.username,
            status: "active" as const,
          },
        ];
      });
    },
    async createSocialPost(publishRequest) {
      if (publishRequest.platform === "youtube" && !publishRequest.youtube)
        throw new Error("publish_spec_missing");
      const body = {
        caption: publishRequest.text,
        social_accounts: [publishRequest.accountId],
        external_id: publishRequest.idempotencyKey,
        ...(publishRequest.mediaUrls === undefined
          ? {}
          : { media: publishRequest.mediaUrls.map((url) => ({ url })) }),
        platform_configurations:
          publishRequest.platform === "youtube"
            ? {
                youtube: {
                  title: publishRequest.youtube?.spec.title,
                  tags: publishRequest.youtube?.spec.tags,
                  category_id: publishRequest.youtube?.spec.categoryId,
                  default_language: publishRequest.youtube?.spec.defaultLanguage,
                  privacy_status: publishRequest.youtube?.spec.privacyStatus,
                  made_for_kids: publishRequest.youtube?.spec.madeForKids,
                  contains_synthetic_media: publishRequest.youtube?.spec.containsSyntheticMedia,
                  thumbnail_url: publishRequest.youtube?.thumbnailUrl,
                },
              }
            : publishRequest.platform === "tiktok" || publishRequest.platform === "tiktok_business"
              ? // Drafts land in the TikTok app inbox; the operator sets privacy, sound and a Shop
                // product there. Direct public posting needs a TikTok-audited API client.
                { [publishRequest.platform]: { is_draft: true } }
              : {
                  [publishRequest.platform]: { placement: publishRequest.placement ?? "timeline" },
                },
      };
      const response = await sendRequest({
        apiKey: publishRequest.apiKey,
        method: "POST",
        url: `${baseUrl}/v1/social-posts`,
        body: JSON.stringify(body),
      });
      const payload = await readAcceptedResponse(response);
      const externalId = extractExternalId(payload);
      const rawStatus = normalizeRawStatus(payload);
      if (!externalId || !rawStatus) throw new Error("provider_malformed_response");
      return resolvePublishResult({
        apiKey: publishRequest.apiKey,
        externalId,
        accountId: publishRequest.accountId,
        rawStatus,
      });
    },
    async findSocialPostByExternalId(reconcileRequest) {
      const url = new URL(`${baseUrl}/v1/social-posts`);
      url.searchParams.set("external_id[]", reconcileRequest.externalId);
      const response = await sendRequest({
        apiKey: reconcileRequest.apiKey,
        method: "GET",
        url: url.toString(),
      });
      const payload = await readAcceptedResponse(response);
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error("provider_malformed_response");
      }
      // external_id is our attempt UUID: it is unique, so filtering by it alone is enough
      // (and, unlike accountId, works for a post made on a non-Instagram account).
      const matches = payload.data.filter(
        (item) => isRecord(item) && item.external_id === reconcileRequest.externalId,
      );
      if (matches.length === 0) throw new Error("provider_unknown_outcome");
      if (matches.length > 1) {
        throw new Error("provider_reconciliation_integrity_failure");
      }
      const matched = matches[0];
      const externalId = extractExternalId(matched);
      const rawStatus = normalizeRawStatus(matched);
      if (!externalId || !rawStatus) throw new Error("provider_malformed_response");
      return resolvePublishResult({
        apiKey: reconcileRequest.apiKey,
        externalId,
        accountId: firstAccountId(matched) ?? reconcileRequest.accountId,
        rawStatus,
      });
    },
    async getSocialPostMetrics(metricsRequest) {
      const postResponse = await sendRequest({
        apiKey: metricsRequest.apiKey,
        method: "GET",
        url: `${baseUrl}/v1/social-posts/${encodeURIComponent(metricsRequest.socialPostId)}`,
      });
      const postPayload = await readAcceptedResponse(postResponse);
      const accountId = firstAccountId(postPayload) ?? metricsRequest.accountId;
      const url = new URL(`${baseUrl}/v1/social-account-feeds/${encodeURIComponent(accountId)}`);
      url.searchParams.append("social_post_id", metricsRequest.socialPostId);
      url.searchParams.append("expand", "metrics");
      const response = await sendRequest({
        apiKey: metricsRequest.apiKey,
        method: "GET",
        url: url.toString(),
      });
      const payload = await readAcceptedResponse(response);
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error("provider_malformed_response");
      }
      const post = payload.data.find(
        (item) => isRecord(item) && item.social_post_id === metricsRequest.socialPostId,
      );
      if (!isRecord(post)) return null;
      return {
        metrics: normalizeMetrics(
          post.metrics,
          input?.onMetricWarning ?? ((code, field) => console.warn(code, { field })),
        ),
        ...(typeof post.platform_url === "string" && post.platform_url.startsWith("https://")
          ? { platformUrl: post.platform_url }
          : {}),
      };
    },
    async createWebhook(webhookRequest) {
      const response = await sendRequest({
        apiKey: webhookRequest.apiKey,
        method: "POST",
        url: `${baseUrl}/v1/webhooks`,
        body: JSON.stringify({
          url: webhookRequest.url,
          event_types: webhookRequest.eventTypes,
        }),
      });
      const payload = await readAcceptedResponse(response);
      if (
        !isRecord(payload) ||
        typeof payload.id !== "string" ||
        typeof payload.secret !== "string"
      ) {
        throw new Error("provider_malformed_response");
      }
      return { id: payload.id, secret: payload.secret };
    },
  };
};
