import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createProduceOfferPackageJob,
  createRenderCreativesJob,
  createWorker,
  HEAVY_JOB_NAMES,
  JobClaimLostError,
  LOCAL_AI_JOB_NAMES,
  renderCreativesMaxAttempts,
} from "./job.js";

describe("createRenderCreativesJob", () => {
  it("uses content and attempt in its idempotency key and carries only identifiers", () => {
    const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
    const job = createRenderCreativesJob({
      workspaceId,
      contentItemId: "22222222-2222-4222-8222-222222222222",
      attempt: 3,
    });

    expect(job).toMatchObject({
      name: "render_creatives",
      idempotencyKey: "creative-render:22222222-2222-4222-8222-222222222222:3",
      attemptPolicy: { maxAttempts: renderCreativesMaxAttempts },
      payload: {
        version: 1,
        workspaceId,
        identifiers: { contentItemId: "22222222-2222-4222-8222-222222222222" },
      },
    });
  });
});

describe("createProduceOfferPackageJob", () => {
  const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
  const offerId = "33333333-3333-4333-8333-333333333333";

  it("is idempotent per offer and carries only identifiers", () => {
    expect(createProduceOfferPackageJob({ workspaceId, offerId })).toEqual({
      name: "produce_offer_package",
      payload: { version: 1, workspaceId, identifiers: { offerId } },
      idempotencyKey: `offer-package:${offerId}`,
      attemptPolicy: { maxAttempts: 6 },
    });
  });

  it("rejects a non-UUID offer id", () => {
    expect(() => createProduceOfferPackageJob({ workspaceId, offerId: "offer-1" })).toThrow();
  });
});

describe("createWorker job deadlines", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const claimed = (name: string) => ({
    id: "job-1",
    workspaceId: workspaceId as never,
    name,
    payload: { version: 1, workspaceId, identifiers: { renderId: workspaceId } },
    leaseToken: "lease-1",
    idempotencyKey: "k",
    attemptCount: 1,
  });
  const fakeQueue = (name: string) => {
    let served = false;
    return {
      claim: vi.fn(async () => {
        if (served) return null;
        served = true;
        return claimed(name);
      }),
      complete: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      failPermanently: vi.fn(async () => undefined),
    };
  };
  const waitForAbort = (signal: AbortSignal | undefined) =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("render_aborted")), { once: true });
    });

  it("aborts a heavy job past its deadline and fails it permanently as render_timeout", async () => {
    const queue = fakeQueue("render_long_form");
    let seen: unknown;
    const worker = createWorker({
      queue,
      handlers: {
        render_long_form: async (_job, context) => {
          seen = context?.signal;
          await waitForAbort(context?.signal);
        },
      },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      heavyJobTimeoutMs: 20,
      sleep: async () => worker.requestStop(),
    });
    await worker.run();
    expect((seen as AbortSignal).reason).toEqual(new Error("render_timeout"));
    expect(queue.failPermanently).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", reason: "render_timeout" }),
    );
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("gives render_long_form its own deadline without touching the other heavy jobs", async () => {
    for (const [name, aborted] of [
      ["render_long_form", false],
      ["render_reel", true],
    ] as const) {
      const queue = fakeQueue(name);
      let signal: AbortSignal | undefined;
      const worker = createWorker({
        queue,
        handlers: {
          [name]: async (_job, context) => {
            signal = context?.signal;
            await new Promise((resolve) => setTimeout(resolve, 60));
          },
        },
        workerId: "w",
        leaseDurationMs: 60_000,
        pollIntervalMs: 1,
        heavyJobTimeoutMs: 20,
        longFormJobTimeoutMs: 10_000,
        sleep: async () => worker.requestStop(),
      });
      await worker.run();
      expect(signal?.aborted).toBe(aborted);
    }
  });

  it("falls back to the heavy deadline when no long-form deadline is set", async () => {
    const queue = fakeQueue("render_long_form");
    let signal: AbortSignal | undefined;
    const worker = createWorker({
      queue,
      handlers: {
        render_long_form: async (_job, context) => {
          signal = context?.signal;
          await waitForAbort(context?.signal);
        },
      },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      heavyJobTimeoutMs: 20,
      sleep: async () => worker.requestStop(),
    });
    await worker.run();
    expect(signal?.reason).toEqual(new Error("render_timeout"));
  });

  it("puts the local-AI deadline on local-AI jobs only", async () => {
    const queue = fakeQueue("direct_scenes");
    const worker = createWorker({
      queue,
      handlers: { direct_scenes: async (_job, context) => waitForAbort(context?.signal) },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      heavyJobTimeoutMs: 60_000,
      localAiJobTimeoutMs: 20,
      sleep: async () => worker.requestStop(),
    });
    await worker.run();
    expect(queue.failPermanently).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", reason: "render_timeout" }),
    );
  });

  it("does not put a deadline on light jobs", async () => {
    const queue = fakeQueue("publish_content");
    let signal: AbortSignal | undefined;
    const worker = createWorker({
      queue,
      handlers: {
        publish_content: async (_job, context) => {
          signal = context?.signal;
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      heavyJobTimeoutMs: 10,
      sleep: async () => worker.requestStop(),
    });
    await worker.run();
    expect(signal?.aborted).toBe(false);
    expect(queue.complete).toHaveBeenCalled();
  });

  it("aborts the job in flight on requestStop and hands it back for a retry", async () => {
    const queue = fakeQueue("render_reel");
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let seen: AbortSignal | undefined;
    const worker = createWorker({
      queue,
      handlers: {
        render_reel: async (_job, context) => {
          seen = context?.signal;
          started();
          await waitForAbort(context?.signal);
        },
      },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      heavyJobTimeoutMs: 60_000,
    });
    const done = worker.run();
    await running;
    worker.requestStop();
    await done;
    expect(seen?.reason).toEqual(new Error("worker_shutdown"));
    expect(queue.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", reason: "worker_shutdown" }),
    );
  });

  it("names the local-AI jobs, disjoint from the heavy render jobs", () => {
    expect(LOCAL_AI_JOB_NAMES).toEqual([
      "direct_scenes",
      "review_frames",
      "generate_plates",
      "upscale_assets",
      "draft_offer_copy",
      "generate_clips",
      "generate_offer_scenes",
      "check_scene_fidelity",
      "check_narration",
    ]);
    expect(
      LOCAL_AI_JOB_NAMES.some((name) => (HEAVY_JOB_NAMES as readonly string[]).includes(name)),
    ).toBe(false);
  });

  it("names the heavy render jobs", () => {
    expect(HEAVY_JOB_NAMES).toEqual(["render_reel", "render_long_form", "render_owned_clip"]);
  });
});

describe("createWorker claim names", () => {
  it("claims only the job names it has handlers for", async () => {
    const queue = {
      claim: vi.fn(async () => null),
      complete: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      failPermanently: vi.fn(async () => undefined),
    };
    const worker = createWorker({
      queue,
      handlers: { publish_content: async () => undefined, render_reel: async () => undefined },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      sleep: async () => worker.requestStop(),
    });
    await worker.run();
    expect(queue.claim).toHaveBeenCalledWith({
      workerId: "w",
      leaseDurationMs: 60_000,
      names: ["publish_content", "render_reel"],
    });
  });
});

describe("createWorker lost claims", () => {
  const job = (name: string) => ({
    id: "job-1",
    workspaceId: "11111111-1111-4111-8111-111111111111" as never,
    name,
    payload: {
      version: 1,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      identifiers: { attemptId: "11111111-1111-4111-8111-111111111111" },
    },
    leaseToken: "lease-1",
    idempotencyKey: "k",
    attemptCount: 1,
  });

  it("keeps running when another worker took over the job before completion", async () => {
    let served = 0;
    const onClaimLost = vi.fn();
    const queue = {
      claim: vi.fn(async () => (served++ < 2 ? job("publish_content") : null)),
      complete: vi.fn().mockRejectedValueOnce(new JobClaimLostError()).mockResolvedValue(undefined),
      retry: vi.fn(async () => undefined),
      failPermanently: vi.fn(async () => undefined),
    };
    const worker = createWorker({
      queue,
      handlers: { publish_content: async () => undefined },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      sleep: async () => worker.requestStop(),
      onClaimLost,
    });
    await expect(worker.run()).resolves.toBeUndefined();
    expect(onClaimLost).toHaveBeenCalledWith({ id: "job-1", name: "publish_content" });
    expect(queue.complete).toHaveBeenCalledTimes(2);
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("keeps running when the retry of a failed job finds the claim lost", async () => {
    let served = false;
    const onClaimLost = vi.fn();
    const queue = {
      claim: vi.fn(async () => {
        if (served) return null;
        served = true;
        return job("publish_content");
      }),
      complete: vi.fn(async () => undefined),
      retry: vi.fn().mockRejectedValue(new JobClaimLostError()),
      failPermanently: vi.fn(async () => undefined),
    };
    const worker = createWorker({
      queue,
      handlers: {
        publish_content: async () => {
          throw new Error("provider_down");
        },
      },
      workerId: "w",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      sleep: async () => worker.requestStop(),
      onClaimLost,
    });
    await expect(worker.run()).resolves.toBeUndefined();
    expect(onClaimLost).toHaveBeenCalledTimes(1);
  });
});
