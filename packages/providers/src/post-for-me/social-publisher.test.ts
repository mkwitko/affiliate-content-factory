import { describe, expect, it } from "vitest";
import { createPostForMeClient } from "./client.js";
import { createPostForMePublisher } from "./social-publisher.js";

describe("Post For Me publisher", () => {
  it("maps a publication request and never exposes the API key in the body", async () => {
    let request: { headers: Record<string, string>; body: string } | undefined;
    const client = createPostForMeClient({
      baseUrl: "https://post-for-me.test",
      transport: async (input) => {
        request = { headers: { ...input.headers }, body: input.body ?? "" };
        return {
          status: 201,
          json: async () => ({
            id: "post-123",
            external_id: "publication-1",
            status: "processing",
          }),
        };
      },
    });
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client,
    });

    await expect(
      publisher.publish({
        secretReference: "secret://workspace/pfm",
        accountId: "account-1",
        platform: "instagram",
        text: "Approved copy",
        idempotencyKey: "publication-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "queued" });
    expect(request?.headers.authorization).toBe("Bearer secret-api-key");
    expect(request?.body).not.toContain("secret-api-key");
    expect(request?.body).toContain("Approved copy");
  });

  it("resolves a Threads account by the connection's handle", async () => {
    let createdAccountId: string | undefined;
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async (_apiKey, platform) => {
          expect(platform).toBe("threads");
          return [
            { id: "spc_wrong", platform: "threads", username: "someone.else", status: "active" },
            {
              id: "spc_threads",
              platform: "threads",
              username: "exampleshop.home",
              status: "active",
            },
          ];
        },
        createSocialPost: async (post) => {
          createdAccountId = post.accountId;
          return { externalId: "post-1", status: "queued" };
        },
        findSocialPostByExternalId: async () => ({ externalId: "post-1", status: "published" }),
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await expect(
      publisher.publish({
        secretReference: "secret://workspace/pfm",
        accountId: "instagram-account",
        platform: "threads",
        text: "Approved copy",
        idempotencyKey: "publication-1",
        accountHandle: "@ExampleShop.Home ",
      }),
    ).resolves.toEqual({ externalId: "post-1", status: "queued" });
    expect(createdAccountId).toBe("spc_threads");
  });

  it("falls back to the sole Threads account when the handle matches nothing", async () => {
    let createdAccountId: string | undefined;
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async () => [
          {
            id: "spc_threads",
            platform: "threads",
            username: "exampleshop.home",
            status: "active",
          },
        ],
        createSocialPost: async (post) => {
          createdAccountId = post.accountId;
          return { externalId: "post-1", status: "queued" };
        },
        findSocialPostByExternalId: async () => ({ externalId: "post-1", status: "published" }),
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await expect(
      publisher.publish({
        secretReference: "secret://workspace/pfm",
        accountId: "instagram-account",
        platform: "threads",
        text: "Approved copy",
        idempotencyKey: "publication-1",
      }),
    ).resolves.toEqual({ externalId: "post-1", status: "queued" });
    expect(createdAccountId).toBe("spc_threads");
  });

  it("resolves a TikTok Business account when no personal TikTok account exists", async () => {
    let created: { accountId: string; platform: string } | undefined;
    const listed: string[] = [];
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async (_key, platform) => {
          listed.push(platform ?? "");
          return platform === "tiktok_business"
            ? [{ id: "spc_tt", platform: "tiktok_business", username: "casa", status: "active" }]
            : [];
        },
        createSocialPost: async (post) => {
          created = { accountId: post.accountId, platform: post.platform };
          return { externalId: "post-1", status: "queued" };
        },
        findSocialPostByExternalId: async () => ({ externalId: "post-1", status: "published" }),
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await publisher.publish({
      secretReference: "secret://workspace/pfm",
      accountId: "instagram-account",
      platform: "tiktok",
      text: "Approved copy",
      idempotencyKey: "publication-1",
    });
    expect(listed).toEqual(["tiktok", "tiktok_business"]);
    expect(created).toEqual({ accountId: "spc_tt", platform: "tiktok_business" });
  });

  it("rejects with provider_account_not_found when the account is ambiguous", async () => {
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async () => [
          { id: "spc_1", platform: "threads", username: "one", status: "active" },
          { id: "spc_2", platform: "threads", username: "two", status: "active" },
        ],
        createSocialPost: async () => ({ externalId: "post-1", status: "queued" }),
        findSocialPostByExternalId: async () => ({ externalId: "post-1", status: "published" }),
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await expect(
      publisher.publish({
        secretReference: "secret://workspace/pfm",
        accountId: "instagram-account",
        platform: "threads",
        text: "Approved copy",
        idempotencyKey: "publication-1",
      }),
    ).rejects.toThrow("provider_account_not_found");
  });

  it("rejects with provider_account_not_found when no account exists for the platform", async () => {
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async () => [],
        createSocialPost: async () => ({ externalId: "post-1", status: "queued" }),
        findSocialPostByExternalId: async () => ({ externalId: "post-1", status: "published" }),
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await expect(
      publisher.publish({
        secretReference: "secret://workspace/pfm",
        accountId: "instagram-account",
        platform: "threads",
        text: "Approved copy",
        idempotencyKey: "publication-1",
        accountHandle: "nobody-here",
      }),
    ).rejects.toThrow("provider_account_not_found");
  });

  it("reconciles a provider post through the workspace account", async () => {
    const publisher = createPostForMePublisher({
      secretStore: {
        get: async () => "secret-api-key",
        put: async () => {},
        delete: async () => {},
      },
      client: {
        listSocialAccounts: async () => [],
        createSocialPost: async () => ({ externalId: "unused", status: "queued" }),
        findSocialPostByExternalId: async (input) => {
          expect(input).toEqual({
            apiKey: "secret-api-key",
            accountId: "account-1",
            externalId: "publication-1",
          });
          return { externalId: "post-123", status: "published" };
        },
        createWebhook: async () => ({ id: "webhook-1", secret: "webhook-secret" }),
        getSocialPostMetrics: async () => null,
      },
    });

    await expect(
      publisher.reconcile({
        secretReference: "secret://workspace/pfm",
        accountId: "account-1",
        externalId: "publication-1",
      }),
    ).resolves.toEqual({ externalId: "post-123", status: "published" });
  });

  it("normalizes provider failures", async () => {
    const client = createPostForMeClient({
      transport: async () => ({ status: 429, json: async () => ({}) }),
    });
    await expect(
      client.createSocialPost({
        apiKey: "secret",
        accountId: "account-1",
        platform: "instagram",
        text: "copy",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow("provider_rate_limited");
  });

  it("fails before the provider when the secret is unavailable", async () => {
    const publisher = createPostForMePublisher({
      secretStore: { get: async () => null, put: async () => {}, delete: async () => {} },
    });
    await expect(
      publisher.publish({
        secretReference: "secret://missing",
        accountId: "account-1",
        platform: "instagram",
        text: "copy",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow("provider_credential_missing");
  });
});
