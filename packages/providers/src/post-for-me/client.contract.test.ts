import { describe, expect, it } from "vitest";
import { createPostForMeClient } from "./client.js";

describe("Post For Me HTTP contract", () => {
  it("maps YouTube metadata to its exact platform configuration without scheduling", async () => {
    let requestBody = "";
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        requestBody = input.body ?? "";
        return { status: 201, json: async () => ({ id: "yt-1", status: "processing" }) };
      },
    });
    await client.createSocialPost({
      apiKey: "secret",
      accountId: "youtube-account-1",
      platform: "youtube",
      text: "Description from caption",
      mediaUrls: ["https://assets.test/video.mp4?sig=short"],
      idempotencyKey: "attempt-1",
      youtube: {
        spec: {
          schemaVersion: 1,
          title: "A useful video",
          intendedFormat: "short",
          tags: ["useful"],
          categoryId: "22",
          defaultLanguage: "pt-BR",
          privacyStatus: "private",
          madeForKids: false,
          containsSyntheticMedia: false,
        },
        thumbnailUrl: "https://assets.test/thumb.jpg?sig=short",
      },
    });
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toEqual({
      caption: "Description from caption",
      social_accounts: ["youtube-account-1"],
      external_id: "attempt-1",
      media: [{ url: "https://assets.test/video.mp4?sig=short" }],
      platform_configurations: {
        youtube: {
          title: "A useful video",
          tags: ["useful"],
          category_id: "22",
          default_language: "pt-BR",
          privacy_status: "private",
          made_for_kids: false,
          contains_synthetic_media: false,
          thumbnail_url: "https://assets.test/thumb.jpg?sig=short",
        },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/scheduled_at|publish_at|unlisted/);
  });

  it("sends the documented top-level create body", async () => {
    let request: { method: string; url: string; body?: string } | undefined;
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        request = {
          method: input.method,
          url: input.url,
          ...(input.body === undefined ? {} : { body: input.body }),
        };
        return {
          status: 201,
          json: async () => ({ id: "post-123", status: "processing" }),
        };
      },
    });

    await expect(
      client.createSocialPost({
        apiKey: "secret",
        accountId: "account-1",
        platform: "instagram",
        text: "Approved caption",
        mediaUrls: ["https://assets.test/signed.jpg"],
        idempotencyKey: "attempt-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "queued" });

    expect(request).toMatchObject({
      method: "POST",
      url: "https://post-for-me.test/v1/social-posts",
      body: JSON.stringify({
        caption: "Approved caption",
        social_accounts: ["account-1"],
        external_id: "attempt-1",
        media: [{ url: "https://assets.test/signed.jpg" }],
        platform_configurations: { instagram: { placement: "timeline" } },
      }),
    });
    const body = JSON.parse(request?.body ?? "{}");
    expect(body.account_id).toBeUndefined();
    expect(body.platform_configurations.instagram.caption).toBeUndefined();
  });

  it("sends a stories placement for an Instagram Stories publish", async () => {
    let request: { body?: string } | undefined;
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        request = { ...(input.body === undefined ? {} : { body: input.body }) };
        return { status: 201, json: async () => ({ id: "post-123", status: "processing" }) };
      },
    });

    await client.createSocialPost({
      apiKey: "secret",
      accountId: "account-1",
      platform: "instagram",
      text: "Approved caption",
      idempotencyKey: "attempt-1",
      placement: "stories",
    });

    const body = JSON.parse(request?.body ?? "{}");
    expect(body.platform_configurations).toEqual({ instagram: { placement: "stories" } });
  });

  it("sends a TikTok post as a draft to the app inbox, under the account's own platform key", async () => {
    const bodies: string[] = [];
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        if (input.body !== undefined) bodies.push(input.body);
        return { status: 201, json: async () => ({ id: "post-123", status: "processing" }) };
      },
    });

    for (const platform of ["tiktok", "tiktok_business"] as const)
      await client.createSocialPost({
        apiKey: "secret",
        accountId: "account-1",
        platform,
        text: "Approved caption",
        idempotencyKey: "attempt-1",
        placement: "timeline",
      });

    expect(bodies.map((body) => JSON.parse(body).platform_configurations)).toEqual([
      { tiktok: { is_draft: true } },
      { tiktok_business: { is_draft: true } },
    ]);
  });

  it("filters reconciliation results by external id, then fetches the matched post's account result", async () => {
    let requestedUrl = "";
    let resultsUrl = "";
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        if (input.url.includes("/v1/social-post-results")) {
          resultsUrl = input.url;
          return {
            status: 200,
            json: async () => ({
              data: [
                {
                  id: "result-1",
                  social_account_id: "threads-account",
                  post_id: "post-123",
                  success: true,
                  error: null,
                  details: {},
                  platform_data: { id: "th-1", url: "https://threads.net/p/th-1" },
                },
              ],
            }),
          };
        }
        requestedUrl = input.url;
        return {
          status: 200,
          json: async () => ({
            data: [
              // A Threads post: its real account differs from the connection's Instagram id.
              {
                id: "post-123",
                external_id: "attempt-1",
                status: "processed",
                social_accounts: [{ id: "threads-account" }],
              },
            ],
          }),
        };
      },
    });

    await expect(
      client.findSocialPostByExternalId({
        apiKey: "secret",
        accountId: "instagram-account",
        externalId: "attempt-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "published" });
    expect(requestedUrl).toContain("external_id%5B%5D=attempt-1");
    expect(resultsUrl).toBe(
      "https://post-for-me.test/v1/social-post-results?post_id=post-123&social_account_id=threads-account",
    );
  });

  it("falls back to the request's accountId when a matched post carries none", async () => {
    let resultsUrl = "";
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        if (input.url.includes("/v1/social-post-results")) {
          resultsUrl = input.url;
          return { status: 200, json: async () => ({ data: [] }) };
        }
        return {
          status: 200,
          json: async () => ({
            data: [{ id: "post-123", external_id: "attempt-1", status: "processed" }],
          }),
        };
      },
    });

    await expect(
      client.findSocialPostByExternalId({
        apiKey: "secret",
        accountId: "account-1",
        externalId: "attempt-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "queued" });
    expect(resultsUrl).toBe(
      "https://post-for-me.test/v1/social-post-results?post_id=post-123&social_account_id=account-1",
    );
  });

  it("keeps a processed post queued when its account has no result yet", async () => {
    const client = createPostForMeClient({
      transport: async (input) => {
        if (input.url.includes("/v1/social-post-results")) {
          return { status: 200, json: async () => ({ data: [] }) };
        }
        return { status: 201, json: async () => ({ id: "post-123", status: "processed" }) };
      },
    });

    await expect(
      client.createSocialPost({
        apiKey: "secret",
        accountId: "account-1",
        platform: "instagram",
        text: "caption",
        idempotencyKey: "attempt-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "queued" });
  });

  it("marks a processed post failed with a short reason, never leaking details", async () => {
    const client = createPostForMeClient({
      transport: async (input) => {
        if (input.url.includes("/v1/social-post-results")) {
          return {
            status: 200,
            json: async () => ({
              data: [
                {
                  social_account_id: "account-1",
                  success: false,
                  error: { message: "x".repeat(400) },
                  details: { sensitive: "must-not-leak" },
                },
              ],
            }),
          };
        }
        return { status: 201, json: async () => ({ id: "post-123", status: "processed" }) };
      },
    });

    const result = await client.createSocialPost({
      apiKey: "secret",
      accountId: "account-1",
      platform: "instagram",
      text: "caption",
      idempotencyKey: "attempt-1",
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toHaveLength(300);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("reduces a plain string provider error to the failure reason", async () => {
    const client = createPostForMeClient({
      transport: async (input) => {
        if (input.url.includes("/v1/social-post-results")) {
          return {
            status: 200,
            json: async () => ({
              data: [
                { social_account_id: "account-1", success: false, error: "rejected by platform" },
              ],
            }),
          };
        }
        return { status: 201, json: async () => ({ id: "post-123", status: "processed" }) };
      },
    });

    await expect(
      client.createSocialPost({
        apiKey: "secret",
        accountId: "account-1",
        platform: "instagram",
        text: "caption",
        idempotencyKey: "attempt-1",
      }),
    ).resolves.toEqual({
      externalId: "post-123",
      status: "failed",
      failureReason: "rejected by platform",
    });
  });

  it("rejects ambiguous matching posts without exposing the provider body", async () => {
    const client = createPostForMeClient({
      transport: async () => ({
        status: 200,
        json: async () => ({
          data: [
            {
              id: "post-1",
              external_id: "attempt-1",
              status: "processed",
              social_accounts: [{ id: "account-1" }],
            },
            {
              id: "post-2",
              external_id: "attempt-1",
              status: "processing",
              social_accounts: [{ id: "account-1" }],
            },
          ],
          sensitive: "must-not-leak",
        }),
      }),
    });

    await expect(
      client.findSocialPostByExternalId({
        apiKey: "secret",
        accountId: "account-1",
        externalId: "attempt-1",
      }),
    ).rejects.toThrow("provider_reconciliation_integrity_failure");
    await expect(
      client.findSocialPostByExternalId({
        apiKey: "secret",
        accountId: "account-1",
        externalId: "attempt-1",
      }),
    ).rejects.not.toThrow("must-not-leak");
  });

  it("lists social accounts for the authenticated key", async () => {
    let request: { method: string; url: string } | undefined;
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        request = { method: input.method, url: input.url };
        return {
          status: 200,
          json: async () => ({
            data: [
              { id: "acc_1", platform: "facebook", username: "user_facebook" },
              { id: "acc_2", platform: "instagram", username: "exampleshop.home" },
            ],
          }),
        };
      },
    });

    await expect(client.listSocialAccounts("secret")).resolves.toEqual([
      { id: "acc_1", platform: "facebook", username: "user_facebook", status: "active" },
      { id: "acc_2", platform: "instagram", username: "exampleshop.home", status: "active" },
    ]);
    expect(request).toEqual({
      method: "GET",
      url: "https://post-for-me.test/v1/social-accounts?platform=instagram",
    });
  });

  it("lists social accounts for another platform when asked", async () => {
    let requestedUrl = "";
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        requestedUrl = input.url;
        return {
          status: 200,
          json: async () => ({
            data: [{ id: "acc_3", platform: "threads", username: "exampleshop.home" }],
          }),
        };
      },
    });

    await expect(client.listSocialAccounts("secret", "threads")).resolves.toEqual([
      { id: "acc_3", platform: "threads", username: "exampleshop.home", status: "active" },
    ]);
    expect(requestedUrl).toBe("https://post-for-me.test/v1/social-accounts?platform=threads");
  });

  it("maps an invalid Post For Me API key to a clear error", async () => {
    const client = createPostForMeClient({
      transport: async () => ({ status: 401, json: async () => ({}) }),
    });

    await expect(client.listSocialAccounts("bad-key")).rejects.toThrow("invalid_api_key");
  });

  it("maps a forbidden Post For Me API key to the same clear error", async () => {
    const client = createPostForMeClient({
      transport: async () => ({ status: 403, json: async () => ({}) }),
    });

    await expect(client.listSocialAccounts("bad-key")).rejects.toThrow("invalid_api_key");
  });

  it("creates a webhook with only the supported post events", async () => {
    let body = "";
    const client = createPostForMeClient({
      transport: async (input) => {
        body = input.body ?? "";
        return { status: 201, json: async () => ({ id: "webhook-1", secret: "secret-1" }) };
      },
    });

    await expect(
      client.createWebhook({
        apiKey: "secret",
        url: "https://app.test/v1/provider-webhooks/post-for-me/connection-1",
        eventTypes: [
          "social.post.created",
          "social.post.updated",
          "social.post.deleted",
          "social.post.result.created",
        ],
      }),
    ).resolves.toEqual({ id: "webhook-1", secret: "secret-1" });
    expect(JSON.parse(body)).toEqual({
      url: "https://app.test/v1/provider-webhooks/post-for-me/connection-1",
      event_types: [
        "social.post.created",
        "social.post.updated",
        "social.post.deleted",
        "social.post.result.created",
      ],
    });
  });

  it("resolves the post's own account before reading its metrics from that account's feed", async () => {
    let feedUrl = "";
    let postUrl = "";
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        if (input.url.includes("/v1/social-account-feeds/")) {
          feedUrl = input.url;
          return {
            status: 200,
            json: async () => ({
              data: [
                {
                  social_post_id: "sp_1",
                  platform_url: "https://www.instagram.com/p/abc",
                  metrics: {
                    likes: 40,
                    comments: 3,
                    reach: 900,
                    saved: 12,
                    shares: 5,
                    views: 1500,
                  },
                },
              ],
            }),
          };
        }
        postUrl = input.url;
        return { status: 200, json: async () => ({ social_accounts: [{ id: "acc 1" }] }) };
      },
    });
    await expect(
      client.getSocialPostMetrics({
        apiKey: "k",
        accountId: "requested-account",
        socialPostId: "sp_1",
      }),
    ).resolves.toEqual({
      metrics: { likes: 40, comments: 3, reach: 900, saves: 12, shares: 5, views: 1500 },
      platformUrl: "https://www.instagram.com/p/abc",
    });
    expect(postUrl).toBe("https://post-for-me.test/v1/social-posts/sp_1");
    // Uses the post's own account (acc 1), not the caller's requested-account.
    expect(feedUrl).toBe(
      "https://post-for-me.test/v1/social-account-feeds/acc%201?social_post_id=sp_1&expand=metrics",
    );
  });

  it("falls back to the given accountId when the post lookup has no social_accounts", async () => {
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        if (input.url.includes("/v1/social-account-feeds/")) {
          return {
            status: 200,
            json: async () => ({
              data: [{ social_post_id: "sp_2", metrics: { likes: 7, replies: 2, views: 80 } }],
            }),
          };
        }
        return { status: 200, json: async () => ({}) };
      },
    });
    await expect(
      client.getSocialPostMetrics({ apiKey: "k", accountId: "a", socialPostId: "sp_2" }),
    ).resolves.toEqual({ metrics: { likes: 7, comments: 2, views: 80 } });
    await expect(
      client.getSocialPostMetrics({ apiKey: "k", accountId: "a", socialPostId: "sp_9" }),
    ).resolves.toBeNull();
  });

  it("maps TikTok and TikTok Business metric names", async () => {
    const metricsFor = (metrics: Record<string, number>) =>
      createPostForMeClient({
        baseUrl: "https://post-for-me.test",
        transport: async (input) =>
          input.url.includes("/social-account-feeds/")
            ? { status: 200, json: async () => ({ data: [{ social_post_id: "tt-1", metrics }] }) }
            : { status: 200, json: async () => ({ social_accounts: [{ id: "tt-account" }] }) },
      }).getSocialPostMetrics({ apiKey: "k", accountId: "a", socialPostId: "tt-1" });

    await expect(
      metricsFor({ view_count: 900, like_count: 40, comment_count: 5, share_count: 3 }),
    ).resolves.toEqual({ metrics: { views: 900, likes: 40, comments: 5, shares: 3 } });
    await expect(
      metricsFor({ video_views: 900, reach: 700, likes: 40, profile_views: 12 }),
    ).resolves.toEqual({ metrics: { views: 900, reach: 700, likes: 40, profileVisits: 12 } });
  });

  it("maps YouTube watch metrics with provider units and warns on suspect values", async () => {
    const warnings: string[] = [];
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      onMetricWarning: (code, field) => warnings.push(`${code}:${field}`),
      transport: async (input) =>
        input.url.includes("/social-account-feeds/")
          ? {
              status: 200,
              json: async () => ({
                data: [
                  {
                    social_post_id: "yt-1",
                    metrics: {
                      views: 12,
                      estimatedMinutesWatched: 2.6,
                      averageViewDuration: 14.4,
                      averageViewPercentage: 0.7,
                      subscribersGained: 3,
                      subscribersLost: 1,
                      engagedViews: 10,
                      dislikes: 5,
                    },
                  },
                ],
              }),
            }
          : { status: 200, json: async () => ({ social_accounts: [{ id: "youtube-account" }] }) },
    });
    await expect(
      client.getSocialPostMetrics({ apiKey: "k", accountId: "a", socialPostId: "yt-1" }),
    ).resolves.toEqual({
      metrics: {
        views: 12,
        estimatedMinutesWatched: 3,
        averageViewDuration: 14,
        averageViewPercentage: 0.7,
        subscribersGained: 3,
        subscribersLost: 1,
        engagedViews: 10,
      },
    });
    expect(warnings).toEqual(["metric_unit_suspect:averageViewPercentage"]);
  });
});
