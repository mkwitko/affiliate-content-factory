import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { EnqueueJobInput } from "@money-maker/core/jobs/job";
import type { CreatePublicationAttemptInput } from "@money-maker/core/publishing/publication";
import type { McpDependencies } from "../server.js";
import { publishContentTool } from "./publish-content.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const variant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "#publi x",
  language: "pt-BR",
  state: "approved",
  approval: {},
} as unknown as ContentVariant;
const channel = { id: "ch1", workspaceId, connectionId: "co1", kind: "threads" } as Channel;

const fixture = () => {
  const attempts: CreatePublicationAttemptInput[] = [];
  const jobs: EnqueueJobInput[] = [];
  const dependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {},
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
    },
    contentRepository: {
      findVariantForWorkspace: async () => variant,
      findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
    },
    offerRepository: {
      findForWorkspace: async () => ({ id: "o1", affiliateUrl: "https://meli.la/abc" }),
    },
    channelRepository: { findForWorkspace: async () => channel },
    providerConnections: {
      findForWorkspace: async () => ({ id: "co1", workspaceId, status: "active" }),
    },
    publicationAttempts: {
      createOrFindByIdempotency: async (input: CreatePublicationAttemptInput) => {
        attempts.push(input);
        return {
          created: true,
          attempt: {
            ...input,
            status: "queued",
            attemptCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        };
      },
    },
    jobQueue: {
      enqueue: async (job: EnqueueJobInput) => {
        jobs.push(job);
        return job;
      },
    },
  } as unknown as McpDependencies;
  return { dependencies, attempts, jobs };
};

const publish = (dependencies: McpDependencies, publishAt?: Date) =>
  publishContentTool(
    {
      workspaceId,
      contentVariantId: "v1",
      idempotencyKey: "publish:v1",
      ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
    },
    actorId,
    dependencies,
  );

describe("publish_content scheduling", () => {
  it("queues the job to run at publishAt and records it on the attempt", async () => {
    const { dependencies, attempts, jobs } = fixture();
    const publishAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await expect(publish(dependencies, publishAt)).resolves.toMatchObject({ ok: true });
    expect(attempts[0]?.scheduledAt).toEqual(publishAt);
    expect(jobs[0]).toMatchObject({ name: "publish_content", availableAt: publishAt });
  });

  it("publishes now without publishAt", async () => {
    const { dependencies, jobs } = fixture();
    await publish(dependencies);
    expect(jobs[0]).not.toHaveProperty("availableAt");
  });

  it("refuses a time in the next five minutes or more than 60 days ahead", async () => {
    for (const offset of [60 * 1000, 61 * 24 * 60 * 60 * 1000]) {
      const { dependencies, jobs } = fixture();
      await expect(publish(dependencies, new Date(Date.now() + offset))).resolves.toEqual({
        ok: false,
        error: "INVALID_ARGUMENTS",
      });
      expect(jobs).toHaveLength(0);
    }
  });

  it("returns the official affiliate link for the variant", async () => {
    const { dependencies } = fixture();
    await expect(publish(dependencies)).resolves.toMatchObject({
      ok: true,
      value: { affiliateUrl: "https://meli.la/abc" },
    });
  });

  it("returns affiliateUrl: null when the offer is unavailable", async () => {
    const { dependencies } = fixture();
    (dependencies as unknown as { offerRepository: unknown }).offerRepository = {
      findForWorkspace: async () => null,
    };
    await expect(publish(dependencies)).resolves.toMatchObject({
      ok: true,
      value: { affiliateUrl: null },
    });
  });

  it("refuses instagram_stories without creating an attempt or job", async () => {
    const { dependencies, attempts, jobs } = fixture();
    (dependencies as unknown as { channelRepository: unknown }).channelRepository = {
      findForWorkspace: async () => ({ ...channel, kind: "instagram_stories" }),
    };
    await expect(publish(dependencies)).resolves.toEqual({
      ok: false,
      error: "MANUAL_PUBLICATION_REQUIRED",
    });
    expect(attempts).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("queues tiktok_video for the TikTok drafts inbox", async () => {
    const { dependencies, attempts, jobs } = fixture();
    (dependencies as unknown as { channelRepository: unknown }).channelRepository = {
      findForWorkspace: async () => ({ ...channel, kind: "tiktok_video" }),
    };
    await expect(publish(dependencies)).resolves.toMatchObject({ ok: true });
    expect(attempts).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it("refuses a TikTok Shop draft once the Shop status is no longer enabled", async () => {
    const { dependencies, attempts, jobs } = fixture();
    (dependencies as unknown as { channelRepository: unknown }).channelRepository = {
      findForWorkspace: async () => ({ ...channel, kind: "tiktok_video", context: {} }),
    };
    (dependencies as unknown as { offerRepository: unknown }).offerRepository = {
      findForWorkspace: async () => ({
        id: "o1",
        marketplace: "tiktok_shop",
        affiliateUrl: "https://shop.tiktok.com/view/product/1",
        snapshots: [],
      }),
    };
    await expect(publish(dependencies)).resolves.toEqual({
      ok: false,
      error: "SHOP_NOT_ENABLED",
    });
    expect(attempts).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("blocks editorial publishing before creating an attempt or calling the queue", async () => {
    const { dependencies, attempts, jobs } = fixture();
    (dependencies as unknown as { contentRepository: unknown }).contentRepository = {
      findVariantForWorkspace: async () => variant,
      findContentItemForWorkspace: async () => ({ id: "c1", offerId: null }),
    };
    await expect(publish(dependencies)).resolves.toEqual({
      ok: false,
      error: "EDITORIAL_PUBLICATION_NOT_ENABLED",
    });
    expect(attempts).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("returns APPROVAL_STALE before queueing when the approved payload changed", async () => {
    const { dependencies, attempts, jobs } = fixture();
    (dependencies as unknown as { contentRepository: unknown }).contentRepository = {
      findVariantForWorkspace: async () => ({
        ...variant,
        approval: { publicationFingerprint: "a".repeat(64) },
      }),
      findContentItemForWorkspace: async () => ({ id: "c1", offerId: "o1" }),
    };
    (dependencies as unknown as { assetRepository: unknown }).assetRepository = {
      findForWorkspace: async () => ({ checksum: "checksum-current" }),
    };
    await expect(publish(dependencies)).resolves.toEqual({ ok: false, error: "APPROVAL_STALE" });
    expect(attempts).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });
});
