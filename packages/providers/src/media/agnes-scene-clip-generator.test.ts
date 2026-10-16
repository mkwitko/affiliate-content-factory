import { SceneClipSubmitError } from "@money-maker/core/assets/scene-clip-generator";
import { describe, expect, it } from "vitest";
import { createAgnesSceneClipGenerator, resolveAgnesModel } from "./agnes-scene-clip-generator.js";

const KEY = "sk-agnes-secret-key-123";
type Call = { url: string; init: RequestInit | undefined };
const fakeFetch = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetcher, calls };
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const request = {
  prompt: "a quiet kitchen",
  negativePrompt: "logos",
  mode: "text" as const,
  width: 768,
  height: 1152,
  seconds: 5,
  seed: 7,
};
// Legacy model: retired by Agnes on 2026-09-25 but still served on 2026-10-01; kept selectable.
const make = (fetcher: typeof fetch, now = () => new Date("2026-10-01T12:00:00Z")) =>
  createAgnesSceneClipGenerator({ apiKey: KEY, fetch: fetcher, now, model: "agnes-video-v2.0" });
const makeFlash = (fetcher: typeof fetch, now = () => new Date("2026-10-01T12:00:00Z")) =>
  createAgnesSceneClipGenerator({ apiKey: KEY, fetch: fetcher, now });

describe("agnes 2.5 flash (default model, wiki.agnes-ai.com 2026-10-01)", () => {
  it("defaults to agnes-video-2.5-flash with the documented 9:16 text shape", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "task_a", video_id: "video_a" }));
    const task = await makeFlash(fetcher).submit(request);
    expect(task.model).toBe("agnes-video-2.5-flash");
    expect(task.providerTaskId).toBe("video_a");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "a quiet kitchen. Avoid: logos",
      mode: "text",
      seconds: "5",
      size: "720P",
      aspect_ratio: "9:16",
      seed: 7,
    });
  });
  it("clamps seconds to the documented 4-12 range as a string", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ video_id: "v" }));
    const flash = makeFlash(fetcher);
    await flash.submit({ ...request, seconds: 3 });
    await flash.submit({ ...request, seconds: 8.4 });
    expect(calls.map((c) => JSON.parse(String(c.init?.body)).seconds)).toEqual(["4", "8"]);
    await expect(flash.submit({ ...request, seconds: 13 })).rejects.toMatchObject({
      code: "agnes_duration_invalid",
    });
  });
  it("sends a reference image as mode reference and two keyframes as first and last frame", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ video_id: "v" }));
    const flash = makeFlash(fetcher);
    await flash.submit({ ...request, mode: "image", referenceImageUrls: ["https://a/1.png"] });
    await flash.submit({
      ...request,
      mode: "keyframes",
      referenceImageUrls: ["https://a/1.png", "https://a/2.png"],
    });
    const [ref, key] = calls.map((c) => JSON.parse(String(c.init?.body)));
    expect(ref).toMatchObject({ mode: "reference", images: ["https://a/1.png"] });
    expect(key).toMatchObject({
      mode: "keyframe",
      first_frame: "https://a/1.png",
      last_frame: "https://a/2.png",
    });
  });
  it("accepts any portrait request size and refuses landscape", async () => {
    const { fetcher } = fakeFetch(() => json({ video_id: "v" }));
    const flash = makeFlash(fetcher);
    await expect(flash.submit({ ...request, width: 720, height: 1280 })).resolves.toMatchObject({
      providerTaskId: "v",
    });
    await expect(flash.submit({ ...request, width: 1280, height: 720 })).rejects.toMatchObject({
      code: "agnes_portrait_only",
    });
  });
  it("polls with model_name, as the 2.5 docs require", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ status: "in_progress" }));
    await makeFlash(fetcher).poll({ providerTaskId: "video_a", model: "agnes-video-2.5-flash" });
    expect(calls[0]?.url).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=video_a&model_name=agnes-video-2.5-flash",
    );
  });
  it("still refuses the paid agnes-video-2.5 model", () => {
    expect(() =>
      createAgnesSceneClipGenerator({ apiKey: KEY, model: "agnes-video-2.5", fetch }),
    ).toThrow("agnes_model_not_allowed");
  });
});

describe("agnes submit", () => {
  it("keeps the video_id for polling, not the task id (real response shape, A0 2026-10-01)", async () => {
    const { fetcher } = fakeFetch(() =>
      json({ id: "task_abc", video_id: "video_xyz", task_id: "task_abc", status: "queued" }),
    );
    expect((await make(fetcher).submit(request)).providerTaskId).toBe("video_xyz");
  });
  it("posts the v2.0 text-to-video shape with a Bearer key and 24 fps frames", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "vid-1" }));
    const task = await make(fetcher).submit(request);
    expect(task).toEqual({
      providerTaskId: "vid-1",
      model: "agnes-video-v2.0",
      submittedAt: "2026-10-01T12:00:00.000Z",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://apihub.agnes-ai.com/v1/videos");
    expect(call?.init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      model: "agnes-video-v2.0",
      prompt: "a quiet kitchen",
      negative_prompt: "logos",
      width: 768,
      height: 1152,
      num_frames: 121,
      frame_rate: 24,
      seed: 7,
    });
  });
  it("sends a frame count of the form 8n + 1, as the API requires (A0, 2026-10-01)", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "v" }));
    await make(fetcher).submit({ ...request, seconds: 3 });
    expect(JSON.parse(String(calls[0]?.init?.body)).num_frames).toBe(73);
  });
  it("treats the free-tier 429 as a retryable rate limit", async () => {
    const { fetcher } = fakeFetch(() =>
      json(
        { error: { message: "rate limit", type: "AgnesAI_error", code: "rate_limit_exceeded" } },
        429,
      ),
    );
    await expect(make(fetcher).submit(request)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });
  it("sends one reference image for image mode and several for keyframes", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "v" }));
    const generator = make(fetcher);
    await generator.submit({ ...request, mode: "image", referenceImageUrls: ["https://a/1.png"] });
    await generator.submit({
      ...request,
      mode: "keyframes",
      referenceImageUrls: ["https://a/1.png", "https://a/2.png"],
    });
    expect(JSON.parse(String(calls[0]?.init?.body)).images).toEqual(["https://a/1.png"]);
    expect(JSON.parse(String(calls[1]?.init?.body)).images).toHaveLength(2);
  });
  it("refuses a mode and image count that disagree", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "v" }));
    const generator = make(fetcher);
    await expect(generator.submit({ ...request, mode: "image" })).rejects.toMatchObject({
      code: "agnes_reference_images_invalid",
    });
    await expect(
      generator.submit({
        ...request,
        mode: "text",
        referenceImageUrls: ["https://a/1.png"],
      }),
    ).rejects.toMatchObject({ code: "agnes_reference_images_invalid" });
    expect(calls).toHaveLength(0);
  });
  it("refuses a paid model, a non-portrait canvas and a clip over 17 s before any request", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: "v" }));
    expect(() =>
      createAgnesSceneClipGenerator({ apiKey: KEY, fetch: fetcher, model: "agnes-video-2.5" }),
    ).toThrow("agnes_model_not_allowed");
    const generator = make(fetcher);
    await expect(generator.submit({ ...request, width: 1152, height: 768 })).rejects.toMatchObject({
      code: "agnes_portrait_only",
    });
    await expect(generator.submit({ ...request, seconds: 18 })).rejects.toMatchObject({
      code: "agnes_duration_invalid",
    });
    expect(calls).toHaveLength(0);
  });
  it("maps video_queue_full and 5xx to a retryable submit error, 401 to a permanent one", async () => {
    const queue = fakeFetch(() => json({ error: { code: "video_queue_full" } }, 503));
    await expect(make(queue.fetcher).submit(request)).rejects.toEqual(
      new SceneClipSubmitError("video_queue_full", true),
    );
    const boom = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(make(boom.fetcher).submit(request)).rejects.toMatchObject({
      code: "upstream_5xx",
      retryable: true,
    });
    const denied = fakeFetch(() => json({ error: { code: "AgnesAI_error" } }, 401));
    await expect(make(denied.fetcher).submit(request)).rejects.toMatchObject({
      code: "unauthorized",
      retryable: false,
    });
  });
  it("never leaks the key through a network error", async () => {
    const { fetcher } = fakeFetch(() => {
      throw new Error(`socket hang up while sending Bearer ${KEY}`);
    });
    const error = await make(fetcher)
      .submit(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "agnes_unreachable", retryable: true });
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(String((error as Error).message)).not.toContain(KEY);
  });
  it("fails a submit response without an id as retryable", async () => {
    const { fetcher } = fakeFetch(() => json({}));
    await expect(make(fetcher).submit(request)).rejects.toMatchObject({
      code: "agnes_bad_response",
      retryable: true,
    });
  });
});

describe("agnes poll", () => {
  const task = {
    providerTaskId: "vid 1",
    model: "agnes-video-v2.0",
    submittedAt: "2026-10-01T11:58:00.000Z",
  };
  it("polls /agnesapi with the encoded video id", async () => {
    const { fetcher, calls } = fakeFetch(() => json({ status: "pending" }));
    await make(fetcher).poll(task);
    expect(calls[0]?.url).toBe("https://apihub.agnes-ai.com/agnesapi?video_id=vid%201");
  });
  it("maps pending and in_progress to pending", async () => {
    for (const status of ["pending", "in_progress"]) {
      const { fetcher } = fakeFetch(() => json({ status }));
      expect(await make(fetcher).poll(task)).toEqual({ status: "pending" });
    }
  });
  it("returns the mp4 url on completed and fails a completed body without one", async () => {
    const ok = fakeFetch(() => json({ status: "completed", url: "https://cdn.example/a.mp4" }));
    expect(await make(ok.fetcher).poll(task)).toEqual({
      status: "completed",
      url: "https://cdn.example/a.mp4",
    });
    const missing = fakeFetch(() => json({ status: "completed" }));
    expect(await make(missing.fetcher).poll(task)).toEqual({
      status: "failed",
      code: "agnes_bad_response",
      retryable: true,
    });
  });
  it("maps a failed body sent with HTTP 200, retryable only for queue and timeout codes", async () => {
    const queue = fakeFetch(() => json({ status: "failed", error: { code: "video_queue_full" } }));
    expect(await make(queue.fetcher).poll(task)).toEqual({
      status: "failed",
      code: "video_queue_full",
      retryable: true,
    });
    const policy = fakeFetch(() => json({ status: "failed", error: { code: "content_policy" } }));
    expect(await make(policy.fetcher).poll(task)).toEqual({
      status: "failed",
      code: "content_policy",
      retryable: false,
    });
    const bare = fakeFetch(() => json({ status: "failed" }));
    expect(await make(bare.fetcher).poll(task)).toMatchObject({
      code: "provider_failed",
      retryable: false,
    });
  });
  it("treats 404 as pending inside 10 minutes of submit and as lost after", async () => {
    const { fetcher } = fakeFetch(() => json({}, 404));
    expect(await make(fetcher).poll(task)).toEqual({ status: "pending" });
    const old = { ...task, submittedAt: "2026-10-01T11:40:00.000Z" };
    expect(await make(fetcher).poll(old)).toEqual({
      status: "failed",
      code: "task_not_found",
      retryable: true,
    });
  });
  it("kills a task still running after 15 minutes as upstream_timeout", async () => {
    const { fetcher } = fakeFetch(() => json({ status: "in_progress" }));
    const old = { ...task, submittedAt: "2026-10-01T11:40:00.000Z" };
    expect(await make(fetcher).poll(old)).toEqual({
      status: "failed",
      code: "upstream_timeout",
      retryable: true,
    });
  });
  it("fails an unknown provider status older than the upstream kill window as retryable", async () => {
    const { fetcher } = fakeFetch(() => json({ status: "queued_weird" }));
    expect(await make(fetcher).poll(task)).toEqual({ status: "pending" });
    const old = { ...task, submittedAt: "2026-10-01T11:40:00.000Z" };
    expect(await make(fetcher).poll(old)).toEqual({
      status: "failed",
      code: "upstream_timeout",
      retryable: true,
    });
  });
  it("treats a status-query rate limit (429) as pending", async () => {
    const { fetcher } = fakeFetch(() =>
      json({ error: { code: 429, message: "too many video status queries" } }, 429),
    );
    await expect(make(fetcher).poll(task)).resolves.toEqual({ status: "pending" });
  });
  it("keeps polling through a network error or gateway 5xx instead of resubmitting", async () => {
    const down = fakeFetch(() => {
      throw new Error("ECONNRESET");
    });
    expect(await make(down.fetcher).poll(task)).toEqual({ status: "pending" });
    const bad = fakeFetch(() => new Response("x", { status: 502 }));
    expect(await make(bad.fetcher).poll(task)).toEqual({ status: "pending" });
  });
  it("fails permanently on a rejected key", async () => {
    const { fetcher } = fakeFetch(() => json({}, 401));
    expect(await make(fetcher).poll(task)).toEqual({
      status: "failed",
      code: "unauthorized",
      retryable: false,
    });
  });
});

describe("resolveAgnesModel", () => {
  it("keeps an allowed model, defaults when unset, and never boots a paid or unknown one", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(resolveAgnesModel(undefined, warn)).toBe("agnes-video-2.5-flash");
    expect(resolveAgnesModel("agnes-video-v2.0", warn)).toBe("agnes-video-v2.0");
    expect(warnings).toEqual([]);
    expect(resolveAgnesModel("agnes-video-2.5", warn)).toBe("agnes-video-2.5-flash");
    expect(resolveAgnesModel("nonsense", warn)).toBe("agnes-video-2.5-flash");
    expect(warnings).toEqual(["agnes_model_not_allowed", "agnes_model_not_allowed"]);
  });
});
