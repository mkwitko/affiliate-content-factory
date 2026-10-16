import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../assets/asset.js";
import { LOCAL_AI_JOB_NAMES, type ClaimedJob, type EnqueueJobInput } from "../jobs/job.js";
import type { SceneClipState, SceneClipStates } from "../content/scene-clip-state.js";
import {
  applyHomeResult,
  claimHomeTask,
  failHomeTask,
  type ClipProbe,
  type HomeResult,
  type HomeTaskDeps,
} from "./tasks.js";
import type { HomeWorkerToken } from "./tokens.js";

// Model policy keeps Wan disabled; a stand-in promoted model exercises the accept path.
vi.mock("../assets/model-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assets/model-policy.js")>();
  const promoted = {
    id: "local:test-video",
    capability: "video_generation",
    enabled: true,
    licensePolicy: "commercial_allowed",
  };
  return {
    ...actual,
    modelPolicyFor: (id: string) => (id === promoted.id ? promoted : actual.modelPolicyFor(id)),
  };
});

const ws = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const renderId = "33333333-3333-4333-8333-333333333333";
const PROMOTED = "local:test-video";
const WAN = "local:wan2.2-ti2v-5b";
const token = (capabilities: HomeWorkerToken["capabilities"]): HomeWorkerToken => ({
  id: "tok",
  workspaceId: ws,
  name: "n",
  tokenHash: "h",
  prefix: "mmhw_a",
  capabilities,
  createdById: "u",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
});
const plate = (id: string, role = "scene", extra: object = {}) =>
  ({
    id,
    workspaceId: ws,
    state: "active",
    mimeType: "image/png",
    checksum: `sum-${id}`,
    provenance: "generated",
    license: "owned",
    metadata: { role },
    ...extra,
  }) as unknown as Asset;
const good: ClipProbe = {
  readable: true,
  hasVideo: true,
  width: 480,
  height: 832,
  frameCount: 33,
  durationMs: 2062,
  decodeErrors: 0,
};

type Over = {
  enabled?: boolean;
  model?: string;
  maxFrames?: number;
  maxBytes?: number;
  referenceRole?: string;
  scenes?: number;
  states?: SceneClipStates;
  probe?: Partial<ClipProbe> | "throw";
  hasClips?: boolean;
};
const setup = (over: Over = {}) => {
  const job: { -readonly [K in keyof ClaimedJob]: ClaimedJob[K] } & {
    status: string;
    reason?: string;
  } = {
    id: randomUUID(),
    workspaceId: ws,
    name: "generate_clips",
    payload: { version: 1, workspaceId: ws, identifiers: { renderId } },
    leaseToken: randomUUID(),
    idempotencyKey: `local-clips:${renderId}:1`,
    attemptCount: 1,
    status: "pending",
  };
  let states: SceneClipStates = { ...(over.states ?? {}) };
  const enqueued: EnqueueJobInput[] = [];
  const stored: unknown[] = [];
  const sceneCount = over.scenes ?? 2;
  const queue: HomeTaskDeps["queue"] = {
    claim: vi.fn(async (input) => {
      if (job.status !== "pending" || !input.names.includes(job.name)) return null;
      job.status = "running";
      return job;
    }),
    takeLease: async (input) => {
      if (job.status !== "running" || input.leaseToken !== job.leaseToken) return null;
      job.leaseToken = randomUUID();
      return { ...job };
    },
    complete: async () => void Object.assign(job, { status: "done" }),
    retry: async (input) => void Object.assign(job, { status: "retry", reason: input.reason }),
    failPermanently: async (input) =>
      void Object.assign(job, { status: "failed", reason: input.reason }),
  };
  const deps = {
    queue,
    leaseDurationMs: 60_000,
    scripts: {
      findScriptForWorkspace: async () => ({
        id: "script-1",
        status: "approved",
        checksum: "c",
        approvedChecksum: "c",
        body: "one two three four five six seven eight nine ten",
        language: "en",
      }),
    },
    content: { findContentItemForWorkspace: async () => ({ id: "item-1", offerId: null }) },
    niches: {},
    storyboards: {},
    renders: {
      findForWorkspace: async () => ({
        id: renderId,
        status: "pending",
        storyboardId: "b",
        attempt: 1,
      }),
    },
    assets: {
      findForWorkspace: async ({ assetId }: { assetId: string }) =>
        plate(assetId, over.referenceRole ?? "scene"),
    },
    store: {
      createDownload: async ({ assetId }: { assetId: string }) => ({
        url: `https://r2/${assetId}`,
      }),
    },
    bank: {},
    reencodeImage: async () => {
      throw new Error("unused");
    },
    ...(over.hasClips === false
      ? {}
      : {
          clips: {
            enabled: over.enabled ?? true,
            model: over.model ?? PROMOTED,
            maxBytes: over.maxBytes ?? 1_000_000,
            maxFrames: over.maxFrames ?? 33,
            storyboards: {
              findForWorkspace: async () => ({
                id: "b",
                scriptId: "script-1",
                contentItemId: "item-1",
                renderer: "ai_clips",
                canvas: "portrait",
                scenes: Array.from({ length: sceneCount }, (_, i) => ({
                  index: i + 1,
                  fromChar: i * 10,
                  toChar: (i + 1) * 10,
                  clipPrompt: `Scene ${i + 1} in a quiet kitchen`,
                  referenceAssetId: `plate-${i + 1}`,
                  captionMode: "word",
                })),
              }),
            },
            offers: { findForWorkspace: async () => null },
            clipState: {
              read: async () => states,
              write: async (request: { sceneIndex: number; state: SceneClipState }) => {
                states = { ...states, [String(request.sceneIndex)]: request.state };
              },
            },
            cache: {
              getOrProduce: async (request: { produce: () => Promise<unknown> }) => {
                stored.push(await request.produce());
                return { assetId: "clip-asset" };
              },
            },
            jobs: { enqueue: async (input: EnqueueJobInput) => (enqueued.push(input), {}) },
            probeVideo: async () => {
              if (over.probe === "throw") throw new Error("ffprobe");
              return { ...good, ...over.probe };
            },
            toMp4: async () => new Uint8Array([1, 2, 3]),
          },
        }),
    now: () => new Date("2026-10-02T12:00:00Z"),
  } as unknown as HomeTaskDeps;
  return { job, deps, enqueued, stored, states: () => states };
};
const post = (over: Partial<Extract<HomeResult, { kind: "generate_clips" }>> = {}): HomeResult => ({
  kind: "generate_clips",
  sceneIndex: 1,
  bytes: new Uint8Array([9, 9, 9, 9]),
  mimeType: "video/webm",
  model: PROMOTED,
  provenance: { runtime: "stable-diffusion.cpp" },
  ...over,
});
const claim = async (h: ReturnType<typeof setup>) => {
  const task = await claimHomeTask(h.deps, token(["video_generation"]));
  if (task?.kind !== "generate_clips") throw new Error(`no clip task (job ${h.job.reason})`);
  return task;
};
const apply = (
  h: ReturnType<typeof setup>,
  task: { jobId: string; leaseToken: string },
  result: HomeResult,
) => applyHomeResult(h.deps, token(["video_generation"]), { ...task, result });

describe("generate_clips home task", () => {
  it("runs in the exclusive local-AI set", () => {
    expect(LOCAL_AI_JOB_NAMES).toContain("generate_clips");
  });

  it("is off by default: no clips deps, or LOCAL_VIDEO_ENABLED false, fails the job", async () => {
    for (const over of [{ hasClips: false }, { enabled: false }]) {
      const h = setup(over);
      await expect(claimHomeTask(h.deps, token(["video_generation"]))).resolves.toBeNull();
      expect(h.job).toMatchObject({ status: "failed", reason: "local_video_disabled" });
    }
  });

  it("refuses Wan while model policy keeps it disabled", async () => {
    const h = setup({ model: WAN });
    await expect(claimHomeTask(h.deps, token(["video_generation"]))).resolves.toBeNull();
    expect(h.job).toMatchObject({ status: "failed", reason: "video_model_not_enabled" });
    const posted = setup();
    const task = await claim(posted);
    await expect(apply(posted, task, post({ model: WAN }))).resolves.toEqual({
      ok: false,
      reason: "clip_model_not_allowlisted",
    });
    expect(posted.stored).toEqual([]);
  });

  it("a token without video_generation cannot claim the job", async () => {
    const h = setup();
    await expect(
      claimHomeTask(h.deps, token(["image_generation", "visual_qa"])),
    ).resolves.toBeNull();
    expect(h.job.status).toBe("pending");
  });

  it("builds one scene task with a signed plate url and a server-chosen portrait profile", async () => {
    const task = await claim(setup());
    expect(task).toMatchObject({
      sceneIndex: 1,
      referenceUrl: "https://r2/plate-1",
      profile: { width: 480, height: 832, frames: 33, fps: 16, steps: 20 },
    });
    expect(task.negativePrompt).toMatch(/logos/);
  });

  it("caps frames at LOCAL_AI_MAX_VIDEO_FRAMES", async () => {
    const task = await claim(setup({ maxFrames: 17 }));
    expect(task.profile.frames).toBe(17);
  });

  it("rejects a listing or product photo as reference", async () => {
    for (const referenceRole of ["listing_image", "canonical_product", "product"]) {
      const h = setup({ referenceRole });
      await expect(claimHomeTask(h.deps, token(["video_generation"]))).resolves.toBeNull();
      expect(h.job).toMatchObject({ status: "failed", reason: "unsafe_reference" });
    }
  });

  it("stores a valid clip as h264 mp4 through the stage cache and continues with the next scene", async () => {
    const h = setup();
    const task = await claim(h);
    await expect(apply(h, task, post())).resolves.toEqual({ ok: true });
    expect(h.states()["1"]).toMatchObject({ status: "ready", assetId: "clip-asset" });
    expect(h.stored[0]).toMatchObject({
      mimeType: "video/mp4",
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { model: PROMOTED, homeWorker: { tokenId: "tok", declaredModel: PROMOTED } },
    });
    expect(h.job.status).toBe("done");
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      name: "generate_clips",
      idempotencyKey: `local-clips:${renderId}:1:2`,
      attemptPolicy: { maxAttempts: 3 },
    });
    h.job.status = "pending";
    const next = await claim(h);
    expect(next.sceneIndex).toBe(2);
    await apply(h, next, post({ sceneIndex: 2 }));
    expect(h.job.status).toBe("done");
    expect(h.enqueued[1]).toMatchObject({ name: "render_long_form" });
  });

  it("a 12-scene storyboard chains jobs that all fit the queue attempt bounds", async () => {
    const h = setup({ scenes: 12 });
    for (let scene = 1; scene <= 12; scene += 1) {
      h.job.status = "pending";
      const task = await claim(h);
      expect(task.sceneIndex).toBe(scene);
      await apply(h, task, post({ sceneIndex: scene }));
    }
    expect(h.enqueued).toHaveLength(12);
    for (const job of h.enqueued) expect(job.attemptPolicy.maxAttempts).toBeGreaterThanOrEqual(1);
    for (const job of h.enqueued) expect(job.attemptPolicy.maxAttempts).toBeLessThanOrEqual(12);
    expect(h.enqueued[11]).toMatchObject({ name: "render_long_form" });
  });

  it("rejects a result for a scene that is not the next one", async () => {
    const h = setup();
    const task = await claim(h);
    await expect(apply(h, task, post({ sceneIndex: 2 }))).resolves.toEqual({
      ok: false,
      reason: "clip_scene_mismatch",
    });
  });

  it.each([
    ["corrupt bytes", { probe: { readable: false, hasVideo: false } }, "unreadable"],
    ["throwing probe", { probe: "throw" as const }, "unreadable"],
    ["decode errors", { probe: { decodeErrors: 2 } }, "decode_errors"],
    ["wrong resolution", { probe: { width: 832, height: 480 } }, "dimensions"],
    ["too few frames", { probe: { frameCount: 20 } }, "frames_short"],
    ["too many frames", { probe: { frameCount: 40 } }, "frames_over_cap"],
    ["zero duration", { probe: { durationMs: 0 } }, "duration"],
    ["oversized bytes", { maxBytes: 3 }, "size"],
  ] as const)("%s is rejected and retried once", async (_name, over, code) => {
    const h = setup(over as Over);
    const task = await claim(h);
    await expect(apply(h, task, post())).resolves.toEqual({
      ok: false,
      reason: `clip_rejected:${code}`,
    });
    expect(h.job.status).toBe("retry");
    expect(h.states()["1"]).toMatchObject({ status: "queued", attempts: 1 });
    expect(h.stored).toEqual([]);
  });

  it("falls back to a static plate after the second objective failure", async () => {
    const h = setup({ scenes: 1, probe: { readable: false, hasVideo: false } });
    await apply(h, await claim(h), post());
    h.job.status = "pending";
    await expect(apply(h, await claim(h), post())).resolves.toEqual({ ok: true });
    expect(h.states()["1"]).toMatchObject({ status: "fallback_static", attempts: 2 });
    expect(h.job.status).toBe("done");
    expect(h.enqueued[0]).toMatchObject({ name: "render_long_form" });
    expect(h.stored).toEqual([]);
  });

  it("a home-side timeout is reported retryable and returns the job to the queue", async () => {
    const h = setup();
    const task = await claim(h);
    await failHomeTask(h.deps, token(["video_generation"]), {
      ...task,
      reason: "sdcpp_timeout",
      retryable: true,
    });
    expect(h.job).toMatchObject({ status: "retry", reason: "home:sdcpp_timeout" });
  });
});
