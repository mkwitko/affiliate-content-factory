import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../channels/channel.js";
import type { ContentVariant } from "../content/content.js";
import { type JobQueue, renderReelMaxAttempts } from "../jobs/job.js";
import {
  assertReelSourceVariant,
  type ReelRender,
  type ReelRenderRepository,
  requestReelRender,
  staleReelRenderMs,
} from "./reel-render.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const channel: Channel = {
  id: "ch1",
  workspaceId,
  connectionId: "co1",
  kind: "instagram_carousel",
  label: "Feed",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
  },
};
const variantId = "22222222-2222-4222-8222-222222222222";
const variant: ContentVariant = {
  id: variantId,
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1", "a2"],
  caption: "#publi x",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
};

describe("assertReelSourceVariant", () => {
  it("passes for an approved instagram_carousel variant", () => {
    expect(() => assertReelSourceVariant(variant, channel)).not.toThrow();
  });

  it("passes for a published instagram_carousel variant", () => {
    expect(() =>
      assertReelSourceVariant({ ...variant, state: "published" }, channel),
    ).not.toThrow();
  });

  it("throws channel_not_carousel for another channel kind", () => {
    expect(() => assertReelSourceVariant(variant, { ...channel, kind: "threads" })).toThrow(
      "channel_not_carousel",
    );
  });

  it("throws content_not_approved for a draft variant", () => {
    expect(() => assertReelSourceVariant({ ...variant, state: "draft" }, channel)).toThrow(
      "content_not_approved",
    );
  });
});

describe("requestReelRender", () => {
  const renderId = "33333333-3333-4333-8333-333333333333";
  const now = new Date("2026-01-01T12:00:00.000Z");
  const pending: ReelRender = {
    id: renderId,
    workspaceId,
    sourceVariantId: variant.id,
    status: "pending",
    voiceMode: "script",
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };

  const renders = (existing: ReelRender | null) => {
    const state = { existing };
    const repo: ReelRenderRepository = {
      createPending: vi.fn(async (input: { voiceMode: ReelRender["voiceMode"] }) =>
        state.existing
          ? { created: false, render: state.existing }
          : {
              created: true,
              render: { ...pending, voiceMode: input.voiceMode, attempt: 1 },
            },
      ),
      resetForRetry: vi.fn(
        async (input: { voiceMode: ReelRender["voiceMode"] }): Promise<ReelRender> => ({
          ...(state.existing as ReelRender),
          status: "pending" as const,
          attempt: (state.existing as ReelRender).attempt + 1,
          voiceMode: input.voiceMode,
        }),
      ),
      findForWorkspace: vi.fn(),
      findByAssetForWorkspace: vi.fn(),
      recordReady: vi.fn(),
      recentMusicTrackIds: vi.fn(),
      recordFailed: vi.fn(),
      invalidateReady: vi.fn(),
      recordNarrationCheck: vi.fn(),
    } satisfies ReelRenderRepository;
    return { repo };
  };

  const jobs = (): Pick<JobQueue, "enqueue"> => ({ enqueue: vi.fn(async () => ({}) as never) });

  it("enqueues a job keyed by attempt for a new render", async () => {
    const { repo } = renders(null);
    const queue = jobs();
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "none",
      now,
    });
    expect(result).toMatchObject({ created: true, render: { status: "pending", attempt: 1 } });
    expect(repo.createPending).toHaveBeenCalledWith({
      id: renderId,
      workspaceId,
      sourceVariantId: variantId,
      voiceMode: "none",
    });
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "render_reel",
        idempotencyKey: `render-reel:${variantId}:1`,
      }),
    );
  });

  it("returns the existing pending render without enqueueing", async () => {
    const { repo } = renders({ ...pending, updatedAt: new Date(now.getTime() - 2 * 60_000) });
    const queue = jobs();
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "script",
      now,
    });
    expect(result.created).toBe(false);
    expect(repo.resetForRetry).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("resets a failed render and enqueues attempt 2", async () => {
    const { repo } = renders({ ...pending, status: "failed", reason: "boom" });
    const queue = jobs();
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "none",
      now,
    });
    expect(repo.resetForRetry).toHaveBeenCalledWith({
      workspaceId,
      sourceVariantId: variantId,
      voiceMode: "none",
    });
    expect(result).toMatchObject({ created: true, render: { attempt: 2 } });
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "render_reel",
        idempotencyKey: `render-reel:${variantId}:2`,
      }),
    );
  });

  it("resets a stale pending render", async () => {
    const { repo } = renders({ ...pending, updatedAt: new Date(now.getTime() - 20 * 60_000) });
    const queue = jobs();
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "script",
      now,
    });
    expect(repo.resetForRetry).toHaveBeenCalledWith({
      workspaceId,
      sourceVariantId: variantId,
      voiceMode: "script",
    });
    expect(result.created).toBe(true);
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("never resets a ready render", async () => {
    const { repo } = renders({ ...pending, status: "ready", assetId: "asset-1" });
    const queue = jobs();
    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "script",
      now,
    });
    expect(result.created).toBe(false);
    expect(repo.resetForRetry).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when resetForRetry races with a render that just became ready", async () => {
    // Simulates the repository-level race: the row read as "failed" became READY (via
    // recordReady) between that read and the resetForRetry call, so the repository's
    // status-scoped updateMany touches nothing and returns the render unchanged.
    const readAsFailed: ReelRender = { ...pending, status: "failed", reason: "boom" };
    const unchangedReady: ReelRender = { ...pending, status: "ready", assetId: "asset-1" };
    const repo: ReelRenderRepository = {
      createPending: vi.fn(async () => ({ created: false, render: readAsFailed })),
      resetForRetry: vi.fn(async () => unchangedReady),
      findForWorkspace: vi.fn(),
      findByAssetForWorkspace: vi.fn(),
      recordReady: vi.fn(),
      recentMusicTrackIds: vi.fn(),
      recordFailed: vi.fn(),
      invalidateReady: vi.fn(),
      recordNarrationCheck: vi.fn(),
    } satisfies ReelRenderRepository;
    const queue = jobs();

    const result = await requestReelRender({
      workspaceId,
      variant,
      channel,
      renders: repo,
      jobs: queue,
      renderId,
      voiceMode: "none",
      now,
    });

    expect(repo.resetForRetry).toHaveBeenCalled();
    expect(result).toEqual({ created: false, render: unchangedReady });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("caps the render job at two attempts", () => {
    expect(renderReelMaxAttempts).toBe(2);
  });

  it("marks a pending render stale after 15 minutes", () => {
    expect(staleReelRenderMs).toBe(15 * 60_000);
  });

  it("rejects a channel that is not instagram_carousel before touching the repository", async () => {
    const { repo } = renders(null);
    const queue = jobs();
    await expect(
      requestReelRender({
        workspaceId,
        variant,
        channel: { ...channel, kind: "threads" },
        renders: repo,
        jobs: queue,
        renderId,
        voiceMode: "script",
      }),
    ).rejects.toThrow("channel_not_carousel");
    expect(repo.createPending).not.toHaveBeenCalled();
  });

  it("rejects an unapproved variant", async () => {
    const { repo } = renders(null);
    const queue = jobs();
    await expect(
      requestReelRender({
        workspaceId,
        variant: { ...variant, state: "draft" },
        channel,
        renders: repo,
        jobs: queue,
        renderId,
        voiceMode: "script",
      }),
    ).rejects.toThrow("content_not_approved");
  });
});

describe("assertReelSourceVariant allowDraft", () => {
  it("accepts a draft or ready_for_review source only when allowed", () => {
    for (const state of ["draft", "ready_for_review"] as const) {
      expect(() => assertReelSourceVariant({ ...variant, state }, channel)).toThrow(
        "content_not_approved",
      );
      expect(() =>
        assertReelSourceVariant({ ...variant, state }, channel, { allowDraft: true }),
      ).not.toThrow();
    }
    expect(() =>
      assertReelSourceVariant({ ...variant, state: "rejected" }, channel, { allowDraft: true }),
    ).toThrow("content_not_approved");
  });
});
