import type {
  SocialPublisher,
  SocialReconcileInput,
  SocialPublishInput,
  SocialPublishResult,
} from "@money-maker/core/publishing/social-publisher";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import { createPostForMeClient, type PostForMeClient, type PostForMePlatform } from "./client.js";

const normalizeHandle = (value: string): string => value.trim().replace(/^@/, "").toLowerCase();

// One Post For Me connection (one API key + brand handle) covers every platform; only the
// Instagram account id is stored on the connection, so other platforms resolve their account
// from the same key's account list by matching the connection's handle.
// A TikTok login connects as "tiktok" or, for a Business account, "tiktok_business".
const platformsFor = (platform: SocialPublishInput["platform"]): readonly string[] =>
  platform === "tiktok" ? ["tiktok", "tiktok_business"] : [platform];

const resolveAccount = async (
  client: PostForMeClient,
  apiKey: string,
  request: SocialPublishInput,
): Promise<{ id: string; platform: PostForMePlatform }> => {
  if (request.platform === "instagram" || request.platform === "youtube")
    return { id: request.accountId, platform: request.platform };
  let accounts: Awaited<ReturnType<PostForMeClient["listSocialAccounts"]>> = [];
  for (const platform of platformsFor(request.platform)) {
    accounts = await client.listSocialAccounts(apiKey, platform);
    if (accounts.length > 0) break;
  }
  const platformOf = (account: { platform: string }): PostForMePlatform =>
    account.platform === "tiktok_business" ? "tiktok_business" : request.platform;
  const handle = request.accountHandle ? normalizeHandle(request.accountHandle) : null;
  const matched = handle
    ? accounts.find((account) => normalizeHandle(account.username) === handle)
    : undefined;
  if (matched) return { id: matched.id, platform: platformOf(matched) };
  const [sole] = accounts;
  if (sole && accounts.length === 1) return { id: sole.id, platform: platformOf(sole) };
  throw new Error("provider_account_not_found");
};

export const createPostForMePublisher = (input: {
  secretStore: SecretStore;
  client?: PostForMeClient;
}): SocialPublisher => {
  const client = input.client ?? createPostForMeClient();
  return {
    async publish(request: SocialPublishInput): Promise<SocialPublishResult> {
      const apiKey = await input.secretStore.get(request.secretReference);
      if (!apiKey) throw new Error("provider_credential_missing");
      const account = await resolveAccount(client, apiKey, request);
      const result = await client.createSocialPost({
        apiKey,
        accountId: account.id,
        platform: account.platform,
        text: request.text,
        idempotencyKey: request.idempotencyKey,
        ...(request.mediaUrls ? { mediaUrls: request.mediaUrls } : {}),
        ...(request.placement ? { placement: request.placement } : {}),
        ...(request.youtube ? { youtube: request.youtube } : {}),
      });
      return {
        externalId: result.externalId,
        status: result.status,
        ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      };
    },
    async readMetrics(request: SocialReconcileInput) {
      const apiKey = await input.secretStore.get(request.secretReference);
      if (!apiKey) throw new Error("provider_credential_missing");
      const result = await client.getSocialPostMetrics({
        apiKey,
        accountId: request.accountId,
        socialPostId: request.externalId,
      });
      if (!result) return null;
      const metrics = result.metrics;
      return {
        metrics: {
          ...(metrics.views !== undefined ? { views: metrics.views } : {}),
          ...(metrics.reach !== undefined ? { reach: metrics.reach } : {}),
          ...(metrics.likes !== undefined ? { likes: metrics.likes } : {}),
          ...(metrics.comments !== undefined ? { comments: metrics.comments } : {}),
          ...(metrics.shares !== undefined ? { shares: metrics.shares } : {}),
          ...(metrics.saves !== undefined ? { saves: metrics.saves } : {}),
          ...(metrics.profileVisits !== undefined ? { profileVisits: metrics.profileVisits } : {}),
          ...(metrics.estimatedMinutesWatched !== undefined
            ? { estimatedMinutesWatched: metrics.estimatedMinutesWatched }
            : {}),
          ...(metrics.averageViewDuration !== undefined
            ? { averageViewDurationSeconds: metrics.averageViewDuration }
            : {}),
          ...(metrics.averageViewPercentage !== undefined
            ? { averageViewPercentage: metrics.averageViewPercentage }
            : {}),
          ...(metrics.subscribersGained !== undefined
            ? { subscribersGained: metrics.subscribersGained }
            : {}),
          ...(metrics.subscribersLost !== undefined
            ? { subscribersLost: metrics.subscribersLost }
            : {}),
          ...(metrics.engagedViews !== undefined ? { engagedViews: metrics.engagedViews } : {}),
        },
        ...(result.platformUrl ? { platformUrl: result.platformUrl } : {}),
      };
    },
    async reconcile(request: SocialReconcileInput): Promise<SocialPublishResult> {
      const apiKey = await input.secretStore.get(request.secretReference);
      if (!apiKey) throw new Error("provider_credential_missing");
      const result = await client.findSocialPostByExternalId({
        apiKey,
        accountId: request.accountId,
        externalId: request.externalId,
      });
      return {
        externalId: result.externalId,
        status: result.status,
        ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      };
    },
  };
};
