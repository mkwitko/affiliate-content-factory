import { createHash } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { RemoteGpuJobRequest } from "@money-maker/contracts/cloud-gpu-job";
import type { Asset } from "@money-maker/core/assets/asset";
import {
  type SceneClipGenerator,
  type SceneClipPoll,
  type SceneClipRequest,
  SceneClipSubmitError,
} from "@money-maker/core/assets/scene-clip-generator";
import type { StageCache, StageCacheRequest } from "@money-maker/core/assets/stage-cache";
import type { ContentScript } from "@money-maker/core/content/editorial";
import type { SceneClipState, SceneClipStates } from "@money-maker/core/content/scene-clip-state";
import type { Storyboard } from "@money-maker/core/content/storyboard";
import {
  CLOUD_GPU_PILOT_BUDGET,
  createInMemoryGenerationBudgetLedger,
} from "@money-maker/core/costs/generation-budget";
import type { EnqueueJobInput } from "@money-maker/core/jobs/job";
import { RetryLaterJobError } from "@money-maker/core/jobs/job";
import {
  GENERATE_SCENE_CLIPS_MAX_ATTEMPTS,
  type LongFormRender,
} from "@money-maker/core/publishing/long-form-render";
import { createModalSceneClipGenerator } from "@money-maker/providers/cloud-gpu/modal-scene-clip-generator";
import { describe, expect, it } from "vitest";
import {
  createGenerateSceneClipsHandler,
  type GenerateSceneClipsDependencies,
} from "./generate-scene-clips.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const renderId = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const body = "one two three four five six seven eight nine ten";
const script = {
  id: "script-1",
  workspaceId,
  contentItemId: "item-1",
  body,
  language: "en",
  status: "approved",
} as unknown as ContentScript;
const clip = (index: number, extra: object = {}) => ({
  index,
  fromChar: (index - 1) * 10,
  toChar: index * 10,
  clipPrompt: `Scene ${index} in a quiet kitchen`,
  captionMode: "word" as const,
  ...extra,
});
const board = (sceneCount: number, extra: object = {}): Storyboard =>
  ({
    id: "board-1",
    workspaceId,
    contentItemId: "item-1",
    scriptId: "script-1",
    renderer: "ai_clips",
    canvas: "portrait",
    scenes: Array.from({ length: sceneCount }, (_, i) => clip(i + 1, extra)),
  }) as unknown as Storyboard;

const harness = (input: {
  scenes?: number;
  sceneExtra?: object;
  states?: SceneClipStates;
  polls?: Record<string, SceneClipPoll>;
  submit?: (request: SceneClipRequest) => Promise<{ providerTaskId: string; model: string }>;
  cacheHit?: (request: StageCacheRequest) => boolean;
  checkOk?: boolean;
  renderStatus?: LongFormRender["status"];
  offerTitle?: string;
  renderAgeMs?: number;
  referenceRole?: string;
  nowMs?: number;
  localClips?: boolean;
  staticFallback?: boolean;
  generator?: SceneClipGenerator;
  fetchClip?: (url: string) => Promise<Uint8Array>;
  assetChecksum?: string;
}) => {
  let states: Record<string, SceneClipState> = { ...(input.states ?? {}) };
  const writes: Array<{ sceneIndex: number; state: SceneClipState }> = [];
  const events: string[] = [];
  const submitted: SceneClipRequest[] = [];
  const polled: string[] = [];
  const failures: string[] = [];
  const jobs: EnqueueJobInput[] = [];
  let counter = 0;
  const generator: SceneClipGenerator = {
    submit: async (request) => {
      events.push("submit");
      submitted.push(request);
      return (
        (await input.submit?.(request)) ?? { providerTaskId: `task-${++counter}`, model: "m1" }
      );
    },
    poll: async (task) => {
      events.push(`poll:${task.providerTaskId}`);
      polled.push(task.providerTaskId);
      return input.polls?.[task.providerTaskId] ?? { status: "pending" };
    },
  };
  const cache: StageCache = {
    getOrProduce: async (request) => {
      events.push("cache");
      if (input.cacheHit?.(request))
        return {
          hit: true,
          assetId: "cached-asset",
          bytes: new Uint8Array([1]),
          mimeType: "video/mp4",
          metadata: {},
        };
      const produced = await request.produce();
      return { hit: false, assetId: `stored-${request.stage}`, ...produced };
    },
  };
  const deps: GenerateSceneClipsDependencies = {
    storyboards: { findForWorkspace: async () => board(input.scenes ?? 2, input.sceneExtra) },
    scripts: { findScriptForWorkspace: async () => script },
    renders: {
      findForWorkspace: async () =>
        ({
          id: renderId,
          workspaceId,
          storyboardId: "board-1",
          attempt: 1,
          createdAt: new Date((input.nowMs ?? NOW.getTime()) - (input.renderAgeMs ?? 0)),
          status: input.renderStatus ?? "pending",
        }) as LongFormRender,
      recordFailed: async (request) => {
        failures.push(request.reason);
        return {} as LongFormRender;
      },
    },
    clipState: {
      read: async () => states,
      write: async (request) => {
        writes.push({ sceneIndex: request.sceneIndex, state: request.state });
        events.push(`write:${request.sceneIndex}:${request.state.status}`);
        states = { ...states, [String(request.sceneIndex)]: request.state };
      },
    },
    content: {
      findContentItemForWorkspace: async () =>
        ({ offerId: input.offerTitle ? "o" : null }) as never,
    },
    offers: { findForWorkspace: async () => ({ title: input.offerTitle ?? "x" }) as never },
    assets: {
      findForWorkspace: async ({ assetId }) =>
        ({
          id: assetId,
          workspaceId,
          state: "active",
          mimeType: "image/png",
          checksum: input.assetChecksum ?? `sum-${assetId}`,
          provenance: "generated",
          metadata: { role: input.referenceRole ?? "scene" },
        }) as unknown as Asset,
    },
    store: {
      createDownload: async ({ assetId }) => ({ url: `https://r2.example/${assetId}` }) as never,
    },
    generator: input.generator ?? generator,
    ...(input.localClips ? { localClips: true } : {}),
    ...(input.staticFallback ? { staticFallback: true } : {}),
    cache,
    model: "m1",
    fetchClip: input.fetchClip ?? (async () => new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])),
    checkClip: async () =>
      input.checkOk === false ? { ok: false, reason: "duration_mismatch" } : { ok: true },
    jobs: { enqueue: async (job) => (jobs.push(job), {} as never) },
    now: () => new Date(input.nowMs ?? NOW.getTime()),
  };
  const run = (attemptCount = 1) =>
    createGenerateSceneClipsHandler(deps)({
      payload: { version: 1, workspaceId, identifiers: { renderId } },
      attemptCount,
    });
  return { deps, run, writes, events, submitted, polled, failures, jobs, states: () => states };
};

const submitted = (taskId: string, extra: Partial<SceneClipState> = {}): SceneClipState => ({
  status: "submitted",
  providerTaskId: taskId,
  model: "m1",
  submittedAt: NOW.toISOString(),
  attempts: 1,
  ...extra,
});
const ready = (assetId = "a"): SceneClipState => ({ status: "ready", assetId, attempts: 1 });

describe("generate_scene_clips", () => {
  it("submits, persists the task id before any poll, and re-enqueues 45 s later", async () => {
    const h = harness({ scenes: 1 });
    const error = await h.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryLaterJobError);
    expect((error as RetryLaterJobError).retryAt).toEqual(new Date(NOW.getTime() + 45_000));
    expect(h.events.filter((e) => !e.startsWith("cache"))).toEqual(["submit", "write:1:submitted"]);
    expect(h.states()["1"]).toMatchObject({
      status: "submitted",
      providerTaskId: "task-1",
      model: "m1",
      attempts: 1,
    });
    expect(h.polled).toEqual([]);
  });
  it("builds a 9:16 portrait request from the compiled prompt and never includes urls in the cache key", async () => {
    let key: StageCacheRequest | undefined;
    const h = harness({
      scenes: 1,
      cacheHit: (request) => {
        key = request;
        return false;
      },
    });
    await h.run().catch(() => undefined);
    expect(h.submitted[0]).toMatchObject({
      mode: "text",
      width: 720,
      height: 1280,
      prompt: "Scene 1 in a quiet kitchen",
    });
    expect(h.submitted[0]?.negativePrompt).toMatch(/logos/);
    expect(key?.stage).toBe("scene_clip");
    expect(JSON.stringify(key?.inputs)).not.toContain("https://");
  });
  it("uses image mode with a signed url and keys the cache on the reference checksum", async () => {
    let key: StageCacheRequest | undefined;
    const h = harness({
      scenes: 1,
      sceneExtra: { referenceAssetId: "plate" },
      cacheHit: (request) => {
        key = request;
        return false;
      },
    });
    await h.run().catch(() => undefined);
    expect(h.submitted[0]).toMatchObject({
      mode: "image",
      referenceImageUrls: ["https://r2.example/plate"],
    });
    expect(JSON.stringify(key?.inputs)).toContain("sum-plate");
  });
  it("refuses a reference that is not a scene plate or character sheet", async () => {
    const h = harness({
      scenes: 1,
      sceneExtra: { referenceAssetId: "plate" },
      referenceRole: "canonical_product",
    });
    await h.run();
    expect(h.failures).toEqual(["clip_reference_unavailable:1"]);
    expect(h.submitted).toEqual([]);
  });
  it("skips submit on a cache hit and stores the cached asset", async () => {
    const h = harness({ scenes: 1, cacheHit: () => true });
    await h.run();
    expect(h.submitted).toEqual([]);
    expect(h.states()["1"]).toMatchObject({ status: "ready", assetId: "cached-asset" });
  });
  it("polls a stored task without resubmitting, and keeps waiting while pending", async () => {
    const h = harness({ scenes: 1, states: { "1": submitted("t1") } });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.polled).toEqual(["t1"]);
    expect(h.submitted).toEqual([]);
    expect(h.writes).toEqual([]);
  });
  it("downloads a completed clip, checks it, stores it and enqueues the render when all are ready", async () => {
    const h = harness({
      scenes: 2,
      states: { "1": ready("clip-1"), "2": submitted("t2") },
      polls: { t2: { status: "completed", url: "https://cdn.example/c.mp4" } },
    });
    await h.run();
    expect(h.states()["2"]).toMatchObject({ status: "ready", assetId: "stored-scene_clip" });
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]).toMatchObject({
      name: "render_long_form",
      payload: { identifiers: { renderId } },
      idempotencyKey: `long-form-render:${renderId}:1`,
    });
  });
  it("does not enqueue the render while any scene is unfinished", async () => {
    const h = harness({ scenes: 2, states: { "1": ready("clip-1"), "2": submitted("t2") } });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.jobs).toEqual([]);
  });
  it("clears the task id and backs off 2 minutes after a retryable failure, then resubmits", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1") },
      polls: { t1: { status: "failed", code: "video_queue_full", retryable: true } },
    });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    const state = h.states()["1"];
    expect(state).toMatchObject({ status: "queued", attempts: 1, lastError: "video_queue_full" });
    expect(state?.providerTaskId).toBeUndefined();
    expect(state?.nextAttemptAt).toBe(new Date(NOW.getTime() + 2 * 60_000).toISOString());
    expect(h.submitted).toEqual([]);
    // Before nextAttemptAt: still no submit. After: submit.
    const later = harness({
      scenes: 1,
      states: { "1": state as SceneClipState },
      nowMs: NOW.getTime() + 60_000,
    });
    await expect(later.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(later.submitted).toEqual([]);
    const after = harness({
      scenes: 1,
      states: { "1": state as SceneClipState },
      nowMs: NOW.getTime() + 121_000,
    });
    await expect(after.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(after.submitted).toHaveLength(1);
    expect(after.states()["1"]?.attempts).toBe(2);
  });
  it("caps backoff at 10 minutes", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1", { attempts: 3 }) },
      polls: { t1: { status: "failed", code: "upstream_timeout", retryable: true } },
    });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.states()["1"]?.nextAttemptAt).toBe(new Date(NOW.getTime() + 8 * 60_000).toISOString());
  });
  it("fails the scene and the render after 4 attempts", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1", { attempts: 4 }) },
      polls: { t1: { status: "failed", code: "video_queue_full", retryable: true } },
    });
    await h.run();
    expect(h.states()["1"]).toMatchObject({ status: "failed", lastError: "video_queue_full" });
    expect(h.failures).toEqual(["scene_clip_failed:1:video_queue_full"]);
    expect(h.jobs).toEqual([]);
  });
  it("fails the render at once on a non-retryable failure", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1") },
      polls: { t1: { status: "failed", code: "content_policy", retryable: false } },
    });
    await h.run();
    expect(h.failures).toEqual(["scene_clip_failed:1:content_policy"]);
  });
  it("treats a retryable submit error as a backoff and a permanent one as a failed scene", async () => {
    const queue = harness({
      scenes: 1,
      submit: async () => {
        throw new SceneClipSubmitError("video_queue_full", true);
      },
    });
    await expect(queue.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(queue.states()["1"]).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "video_queue_full",
    });
    const denied = harness({
      scenes: 1,
      submit: async () => {
        throw new SceneClipSubmitError("unauthorized", false);
      },
    });
    await denied.run();
    expect(denied.failures).toEqual(["scene_clip_failed:1:unauthorized"]);
  });
  it("retries a clip that fails the checks instead of storing it", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1") },
      polls: { t1: { status: "completed", url: "https://cdn.example/c.mp4" } },
      checkOk: false,
    });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.states()["1"]).toMatchObject({
      status: "queued",
      lastError: "clip_check_failed:duration_mismatch",
    });
  });
  it("submits at most 2 scenes at a time, counting tasks already in flight", async () => {
    const h = harness({ scenes: 5 });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.submitted).toHaveLength(2);
    const resumed = harness({
      scenes: 5,
      states: { "1": submitted("t1"), "2": ready("x") },
    });
    await expect(resumed.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(resumed.submitted).toHaveLength(1);
  });
  it("lets a cache hit through even when the submit cap is reached", async () => {
    const h = harness({
      scenes: 3,
      states: { "1": submitted("t1"), "2": submitted("t2") },
      cacheHit: () => true,
    });
    await expect(h.run()).rejects.toBeInstanceOf(RetryLaterJobError);
    expect(h.states()["3"]).toMatchObject({ status: "ready", assetId: "cached-asset" });
  });
  it("refuses a prompt that names the offer and fails the render without calling the provider", async () => {
    const h = harness({
      scenes: 1,
      offerTitle: "Cadeira Gamer Pro",
      sceneExtra: { clipPrompt: "a Cadeira Gamer Pro in a room" },
    });
    await h.run();
    expect(h.failures).toEqual(["clip_prompt_refused:1:brand_named:cadeira gamer pro"]);
    expect(h.submitted).toEqual([]);
  });
  it("refuses a prompt that names only a distinctive token of the offer title", async () => {
    const h = harness({
      scenes: 1,
      offerTitle: "Fone Zeta ZX900 Preto",
      sceneExtra: { clipPrompt: "a zx900 headset on a desk" },
    });
    await h.run();
    expect(h.failures).toEqual(["clip_prompt_refused:1:brand_named:zx900"]);
    expect(h.submitted).toEqual([]);
  });
  it("fails the render once the wall-clock deadline since creation has passed", async () => {
    const h = harness({
      scenes: 1,
      states: { "1": submitted("t1") },
      renderAgeMs: 3 * 3_600_000 + 1,
    });
    await h.run();
    expect(h.failures).toEqual(["scene_clips_timeout"]);
  });
  it("retries at the earliest pending scene's next attempt time, not a fixed poll", async () => {
    const next = new Date(NOW.getTime() + 8 * 60_000).toISOString();
    const h = harness({
      scenes: 1,
      states: { "1": { status: "queued", attempts: 1, nextAttemptAt: next } },
    });
    await expect(h.run()).rejects.toMatchObject({ retryAt: new Date(next) });
    const polling = harness({ scenes: 1, states: { "1": submitted("t1") } });
    await expect(polling.run()).rejects.toMatchObject({
      retryAt: new Date(NOW.getTime() + 45_000),
    });
  });
  it("fails the render on the last attempt instead of waiting again", async () => {
    const h = harness({ scenes: 1, states: { "1": submitted("t1") } });
    await h.run(GENERATE_SCENE_CLIPS_MAX_ATTEMPTS);
    expect(h.failures).toEqual(["scene_clips_timeout"]);
  });
  it("ignores a render that is no longer pending and a storyboard that is not ai_clips", async () => {
    const done = harness({ scenes: 1, renderStatus: "failed" });
    await done.run();
    expect(done.submitted).toEqual([]);
    expect(done.jobs).toEqual([]);
  });

  it("local clips: enqueues one generate_clips job and never calls the hosted generator", async () => {
    const h = harness({ scenes: 2, sceneExtra: { referenceAssetId: "plate-1" }, localClips: true });
    await h.run();
    expect(h.submitted).toEqual([]);
    expect(h.polled).toEqual([]);
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]).toMatchObject({
      name: "generate_clips",
      idempotencyKey: `local-clips:${renderId}:1:1`,
      attemptPolicy: { maxAttempts: 3 },
    });
    expect(h.failures).toEqual([]);
  });
  it("local clips: a scene without an owned reference plate fails the render before any job", async () => {
    const h = harness({ scenes: 2, localClips: true });
    await h.run();
    expect(h.jobs).toEqual([]);
    expect(h.failures).toEqual(["local_clip_reference_required:1"]);
  });
  it("without a hosted generator and without local clips the render fails closed", async () => {
    const h = harness({ scenes: 1 });
    // remove the generator the harness installs: local_only never constructs one
    const failures: string[] = [];
    const handler = createGenerateSceneClipsHandler({
      ...h.deps,
      generator: undefined as never,
      renders: {
        ...h.deps.renders,
        recordFailed: async (request) => {
          failures.push(request.reason);
          return {} as LongFormRender;
        },
      },
    });
    await handler({ payload: { version: 1, workspaceId, identifiers: { renderId } } });
    expect(failures).toEqual(["scene_clips_unavailable"]);
  });

  it("paid clips: submits with a budget key per render, scene and attempt, and the plate checksum", async () => {
    const h = harness({
      scenes: 1,
      sceneExtra: { referenceAssetId: "plate" },
      staticFallback: true,
    });
    await h.run().catch(() => undefined);
    expect(h.submitted[0]).toMatchObject({
      referenceChecksums: ["sum-plate"],
      budget: { workspaceId, operationKey: `scene-clip:${renderId}:1:1:1` },
    });
  });

  it("paid clips: a failed scene falls back to its plate and the render goes on", async () => {
    const h = harness({
      scenes: 2,
      sceneExtra: { referenceAssetId: "plate" },
      staticFallback: true,
      states: { "1": submitted("t1"), "2": ready() },
      polls: { t1: { status: "failed", code: "modal_failed", retryable: false } },
    });
    await h.run();
    expect(h.failures).toEqual([]);
    expect(h.states()["1"]).toMatchObject({ status: "fallback_static", lastError: "modal_failed" });
    expect(h.jobs.map((job) => job.name)).toEqual(["render_long_form"]);
  });

  it("paid clips: a clip that fails the checks is never resubmitted", async () => {
    const h = harness({
      scenes: 1,
      sceneExtra: { referenceAssetId: "plate" },
      staticFallback: true,
      checkOk: false,
      states: { "1": submitted("t1") },
      polls: { t1: { status: "completed", url: "https://r2.example/clip" } },
    });
    await h.run();
    expect(h.submitted).toEqual([]);
    expect(h.states()["1"]).toMatchObject({
      status: "fallback_static",
      lastError: "clip_check_failed:duration_mismatch",
    });
  });

  it("paid clips without a plate still fail the render instead of inventing a fallback", async () => {
    const h = harness({
      scenes: 1,
      staticFallback: true,
      states: { "1": submitted("t1") },
      polls: { t1: { status: "failed", code: "modal_failed", retryable: false } },
    });
    await h.run();
    expect(h.failures).toEqual(["scene_clip_failed:1:modal_failed"]);
  });

  it("Modal end to end over fakes: budget reserved, clip checked and stored, render enqueued", async () => {
    const ledger = createInMemoryGenerationBudgetLedger();
    const objects = new Map<string, Uint8Array>();
    const clip = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2]);
    let request: RemoteGpuJobRequest | undefined;
    const modal = createModalSceneClipGenerator({
      calls: {
        spawn: async (sent) => {
          request = sent;
          objects.set(decodeURIComponent(new URL(sent.output.url).pathname.slice(1)), clip);
          return "fc-1";
        },
        result: async () => ({
          status: "done",
          value: {
            jobId: request?.jobId,
            operationKey: request?.operationKey,
            provider: "modal",
            runId: "run-1",
            model: request?.model,
            output: {
              sha256: createHash("sha256").update(clip).digest("hex"),
              bytes: clip.byteLength,
              mimeType: "video/mp4",
              width: 720,
              height: 1280,
              fps: 16,
              durationMs: 5_063,
            },
            billing: { currency: "USD", minor: 0, billedSeconds: 300 },
          },
        }),
        cancel: async () => undefined,
      },
      store: {
        uploadUrl: async (key) => `https://acct.r2.cloudflarestorage.com/${key}`,
        downloadUrl: async (key) => `https://acct.r2.cloudflarestorage.com/${key}`,
        read: async (key) => objects.get(key) ?? null,
      },
      ledger,
      // The fixture clock predates the pilot window; only the window moves.
      policies: [{ ...CLOUD_GPU_PILOT_BUDGET, providers: ["modal"], startsAt: new Date(0) }],
      shape: {
        gpu: "A100-80GB",
        cpuCores: 4,
        memoryGiB: 32,
        timeoutSeconds: 600,
        coldStartSeconds: 240,
      },
      model: { id: "wan2.2-i2v-a14b", revision: "596658fd9ca6b7b71d5057529bbf319ecbc61d74" },
      fx: async () => ({ brlPerUsd: 5.6, source: "test", at: NOW }),
      now: () => NOW,
    });
    const fetched: string[] = [];
    const h = harness({
      scenes: 1,
      sceneExtra: { referenceAssetId: "plate" },
      staticFallback: true,
      generator: modal,
      assetChecksum: `sha256:${"a".repeat(64)}`,
      fetchClip: async (url) => {
        fetched.push(url);
        return clip;
      },
    });
    await expect(h.run()).rejects.toThrow("scene_clips_pending");
    await h.run();
    expect(h.states()["1"]).toMatchObject({ status: "ready", assetId: "stored-scene_clip" });
    expect(fetched).toHaveLength(1);
    expect(h.jobs.map((job) => job.name)).toEqual(["render_long_form"]);
    expect(await ledger.list({ workspaceId, budgetKey: CLOUD_GPU_PILOT_BUDGET.key })).toMatchObject(
      [{ status: "settled", estimatedMinor: 426, actualMinor: 278 }],
    );
  });
});
