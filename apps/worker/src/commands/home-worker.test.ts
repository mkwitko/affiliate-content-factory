import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { checkDirectorOutput } from "@money-maker/core/content/direct-scenes";
import { createContentScript } from "@money-maker/core/content/editorial";
import { STICK_V1_CATALOG } from "@money-maker/core/explainer/scene-director";
import type { HomeTask } from "@money-maker/core/home-worker/tasks";
import { describe, expect, it, vi } from "vitest";
import {
  createHomeApi,
  type HomeApi,
  type HomeExecutors,
  homeExecutorsFrom,
  readHomeEnvFile,
  runHomeWorkerOnce,
  servedCapabilities,
} from "./home-worker.js";

const plateTask: HomeTask = {
  kind: "generate_plates",
  jobId: "33333333-3333-4333-8333-333333333333",
  leaseToken: "44444444-4444-4444-8444-444444444444",
  requests: [{ key: "plate:kitchen", prompt: "a kitchen" }],
};

const fakeApi = (task: HomeTask | null) => ({
  claim: vi.fn(async () => task),
  result: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
});
const noMedia = {
  fetchVideo: async () => new Uint8Array(),
  extractFrames: async () => [],
};

describe("home worker client (ADR 0012)", () => {
  it("uses the HTTP image generator when configured without a local command", () => {
    expect(
      homeExecutorsFrom({
        IMAGE_GEN_URL: "http://127.0.0.1:7860",
        IMAGE_GEN_MODEL: "local:z-image-turbo",
      }).generator,
    ).toBeUndefined();
    expect(
      homeExecutorsFrom({
        LOCAL_AI_ENABLED: "true",
        IMAGE_GEN_URL: "http://127.0.0.1:7860",
        IMAGE_GEN_MODEL: "local:z-image-turbo",
      }).generator,
    ).toBeDefined();
  });
  it("posts generated plates as base64 with the model name", async () => {
    const api = fakeApi(plateTask);
    const generator = {
      generate: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png" as const,
        width: 1024,
        height: 1024,
        neurons: 0,
        model: "flux2-klein-4b",
        seed: 7,
        provenance: { runtime: "stable-diffusion.cpp", observedModel: "Z Image" },
      })),
    };
    expect(await runHomeWorkerOnce(api, { generator, ...noMedia })).toBe(true);
    expect(api.result).toHaveBeenCalledWith(plateTask, {
      kind: "generate_plates",
      plates: [
        {
          key: "plate:kitchen",
          base64: "AQID",
          model: "flux2-klein-4b",
          seed: 7,
          provenance: { runtime: "stable-diffusion.cpp", observedModel: "Z Image" },
        },
      ],
    });
  });

  it("returns a task it cannot run to the queue instead of dropping it", async () => {
    const api = fakeApi(plateTask);
    await runHomeWorkerOnce(api, noMedia);
    expect(api.fail).toHaveBeenCalledWith(plateTask, "generator_not_configured", true);
    expect(api.result).not.toHaveBeenCalled();
  });

  it("repairs and corrects the copy draft before posting it; a missing copywriter retries", async () => {
    const task = {
      kind: "draft_offer_copy",
      jobId: "j",
      leaseToken: "l",
      input: {
        offer: { title: "Cesto", facts: [{ key: "seller", value: "Loja" }] },
        buyerVoice: { untrusted: true, praise: [], complaints: [], questions: [] },
        niche: { name: "casa", editorialVoice: "direta", language: "pt-BR" },
        channels: ["threads"],
        slideCount: 6,
      },
      validation: { sourceFactKeys: ["seller"], captionMaxLength: { threads: 500 } },
    } as unknown as HomeTask;
    const slides = Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      total: 6,
      template: i === 0 ? "hero" : "benefit",
      headline: i === 0 ? "Cesto que some no canto" : `Motivo prático ${i + 1}`,
      claims: [],
    }));
    const badHeadline = {
      slides: slides.map((s, i) => (i === 1 ? { ...s, headline: "Frete no cesto" } : s)),
      captions: { threads: "Achado útil." },
    };
    const fixed = { slides, captions: { threads: "Achado útil. Veja www.loja.com" }, junk: 1 };
    const writer = { draft: vi.fn().mockResolvedValueOnce(badHeadline).mockResolvedValue(fixed) };
    const api = fakeApi(task);
    await runHomeWorkerOnce(api, { copywriter: { writer, model: "local:m" }, ...noMedia });
    expect(writer.draft).toHaveBeenCalledTimes(2);
    expect(writer.draft.mock.calls[1]?.[1]).toMatchObject({ previous: badHeadline });
    expect(api.result).toHaveBeenCalledWith(task, {
      kind: "draft_offer_copy",
      draft: { slides, captions: { threads: "Achado útil." } },
      model: "local:m",
      provenance: { runtime: "llama.cpp" },
    });
    // With a cast, the art director writes one line per validated slide; its failure costs nothing.
    const directedTask = {
      ...task,
      artDirection: {
        product: "Cesto",
        character: { name: "Carla", description: "35" },
        otherNames: ["Bia"],
        world: "a small flat",
      },
    } as HomeTask;
    const direct = vi.fn(async () => ({ lines: [{ index: 1, scene: "Carla at home." }] }));
    const directed = fakeApi(directedTask);
    await runHomeWorkerOnce(directed, {
      copywriter: { writer: { draft: vi.fn(async () => fixed) }, model: "local:m" },
      artDirector: { direct },
      ...noMedia,
    });
    expect(direct).toHaveBeenCalledWith(
      expect.objectContaining({
        character: { name: "Carla", description: "35" },
        slides: slides.map(({ index, template, headline }) => ({
          index,
          template,
          headline,
          body: undefined,
        })),
      }),
    );
    expect(directed.result).toHaveBeenCalledWith(
      directedTask,
      expect.objectContaining({ sceneLines: { lines: [{ index: 1, scene: "Carla at home." }] } }),
    );
    const broken = fakeApi(directedTask);
    await runHomeWorkerOnce(broken, {
      copywriter: { writer: { draft: vi.fn(async () => fixed) }, model: "local:m" },
      artDirector: {
        direct: vi.fn(async () => Promise.reject(new Error("art_director_http_500"))),
      },
      ...noMedia,
    });
    expect(broken.result).toHaveBeenCalledWith(
      directedTask,
      expect.not.objectContaining({ sceneLines: expect.anything() }),
    );
    const stuck = fakeApi(task);
    const stuckWriter = { draft: vi.fn(async () => badHeadline) };
    await runHomeWorkerOnce(stuck, { copywriter: { writer: stuckWriter, model: "m" }, ...noMedia });
    expect(stuckWriter.draft).toHaveBeenCalledTimes(3);
    expect(stuck.fail).toHaveBeenCalledWith(task, "copy_rejected:copy_shipping_unverified", true);
    const missing = fakeApi(task);
    await runHomeWorkerOnce(missing, noMedia);
    expect(missing.fail).toHaveBeenCalledWith(task, "copywriter_not_configured", true);
    const copyEnv = { COPYWRITER_URL: "http://127.0.0.1:8081" };
    expect(homeExecutorsFrom(copyEnv).copywriter).toBeDefined(); // the promoted default
    const distill = { ...copyEnv, COPYWRITER_MODEL: "local:qwen3.8-9b-distill" };
    expect(homeExecutorsFrom(distill).copywriter).toBeUndefined(); // not promoted for copy
    expect(() => homeExecutorsFrom({ COPYWRITER_URL: "http://10.0.0.2:8081" })).toThrow();
  });

  it("posts only the hook options that pass the copy gates", async () => {
    const task = {
      kind: "draft_offer_copy",
      jobId: "j",
      leaseToken: "l",
      input: {
        offer: { title: "Cesto", facts: [{ key: "seller", value: "Loja" }] },
        buyerVoice: { untrusted: true, praise: [], complaints: [], questions: [] },
        niche: { name: "casa", editorialVoice: "direta", language: "pt-BR" },
        channels: ["threads"],
        slideCount: 6,
      },
      validation: { sourceFactKeys: ["seller"], captionMaxLength: { threads: 500 } },
    } as unknown as HomeTask;
    const slides = Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      total: 6,
      template: i === 0 ? "hero" : "benefit",
      headline: i === 0 ? "Cesto que some no canto" : `Motivo prático ${i + 1}`,
      claims: [],
    }));
    const good = { headline: "Sobra espaço no armário", captionFirstLine: "Organiza sem esforço." };
    const writer = {
      draft: vi.fn(async () => ({
        slides,
        captions: { threads: "Achado útil." },
        hookOptions: [good, { headline: "Só R$ 9", captionFirstLine: "Corre." }],
      })),
    };
    const api = fakeApi(task);
    await runHomeWorkerOnce(api, { copywriter: { writer, model: "local:m" }, ...noMedia });
    expect(api.result).toHaveBeenCalledWith(task, {
      kind: "draft_offer_copy",
      draft: { slides, captions: { threads: "Achado útil." }, hookOptions: [good] },
      model: "local:m",
      provenance: { runtime: "llama.cpp" },
    });
  });

  it("idles when the API has no task", async () => {
    expect(await runHomeWorkerOnce(fakeApi(null) as HomeApi, noMedia)).toBe(false);
  });

  it("sends the bearer token and refuses redirects", async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createHomeApi(new URL("https://api.example.com"), "mmhw_x", doFetch);
    expect(await api.claim()).toBeNull();
    expect(doFetch).toHaveBeenCalledWith(
      new URL("https://api.example.com/v1/home-worker/claim"),
      expect.objectContaining({
        headers: { authorization: "Bearer mmhw_x" },
        redirect: "error",
      }),
    );
  });

  it("records the worker version with each result, never the token in the body", async () => {
    const doFetch = vi.fn(async () => Response.json({ ok: true }));
    const api = createHomeApi(new URL("https://api.example.com"), "mmhw_x", doFetch, "abc1234");
    await api.result({ kind: "direct_scenes", jobId: "j", leaseToken: "l" } as never, {
      kind: "direct_scenes",
      scenes: [],
    });
    const body = String((doFetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body);
    expect(JSON.parse(body)).toMatchObject({ leaseToken: "l", workerVersion: "abc1234" });
    expect(body).not.toContain("mmhw_x");
  });

  it("reads the token from a private env file and refuses one other users can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "home-env-"));
    const path = join(dir, "home-worker.env");
    writeFileSync(path, "MONEY_MAKER_HOME_TOKEN=mmhw_secret\n", { mode: 0o600 });
    expect(readHomeEnvFile(path)).toEqual({ MONEY_MAKER_HOME_TOKEN: "mmhw_secret" });
    expect(readHomeEnvFile(join(dir, "missing.env"))).toBeNull();
    if (process.platform === "win32") return;
    chmodSync(path, 0o644);
    expect(() => readHomeEnvFile(path)).toThrow(/chmod 600/);
    // The refusal names the file, never its contents.
    expect(() => readHomeEnvFile(path)).not.toThrow(/mmhw_secret/);
  });

  it("posts a short-form direction as the director plan the server re-checks", async () => {
    const body = "Sam sees a price tag. He picks up the notebook. He pays at the counter.";
    const script = createContentScript({
      workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
      contentItemId: "item-1",
      version: 1,
      body,
      language: "en-US",
      claims: [],
      beats: [{ kind: "hook", atChar: 0 }],
      actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
    });
    const input = {
      script: { ...script, status: "approved" as const },
      persona: [
        {
          key: "sam",
          name: "Sam",
          role: "main" as const,
          rigId: "stick-v1" as const,
          rigVersion: 1 as const,
          palette: { line: "#2B2B2B", fill: "#FFFFFF", accent: "#F2C230" },
        },
      ],
      catalog: STICK_V1_CATALOG,
      timing: [],
    };
    const visual = (purpose: string, background: string, movement: string) => ({
      newScene: true,
      visual: {
        purpose,
        background,
        actors: [
          { characterKey: "sam", pose: "neutral", expression: "neutral", position: "center" },
        ],
        props: [],
        overlays: [],
        camera: { shot: "medium", movement },
        transition: "hard_cut",
        captionMode: "word",
      },
    });
    const plan = {
      segments: [
        visual("hook", "store", "none"),
        visual("explanation", "kitchen", "push_in"),
        visual("payoff", "street", "none"),
      ],
    };
    const task: HomeTask = {
      kind: "direct_scenes",
      jobId: "33333333-3333-4333-8333-333333333333",
      leaseToken: "44444444-4444-4444-8444-444444444444",
      input,
    };
    const api = fakeApi(task);
    await runHomeWorkerOnce(
      api as unknown as HomeApi,
      {
        director: { direct: async () => plan },
        media: noMedia,
      } as never,
    );
    const posted = (api.result.mock.calls[0] as unknown as [unknown, { scenes: unknown }])[1];
    expect(checkDirectorOutput(posted.scenes, input).ok).toBe(true);
  });

  it("refuses a long-form task above the chapter cap before directing anything", async () => {
    const sentence = (n: number) => `Item number ${n} shows what the bill really includes today.`;
    const body = Array.from({ length: 140 }, (_, n) => sentence(n + 1)).join(" ");
    const input = {
      script: createContentScript({
        workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
        contentItemId: "item-1",
        version: 1,
        body,
        language: "en-US",
        claims: [],
        beats: Array.from({ length: 13 }, (_, k) => ({
          kind: "chapter" as const,
          atChar: body.indexOf(sentence((k + 1) * 10 + 1)),
          label: `c${k}`,
        })),
        actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
      }),
      persona: [],
      catalog: STICK_V1_CATALOG,
      timing: [],
    };
    const task = {
      kind: "direct_scenes",
      jobId: "33333333-3333-4333-8333-333333333333",
      leaseToken: "44444444-4444-4444-8444-444444444444",
      longForm: true,
      input,
    } as unknown as HomeTask;
    const api = fakeApi(task);
    const direct = vi.fn();
    await runHomeWorkerOnce(
      api as unknown as HomeApi,
      { director: { direct }, media: noMedia } as never,
    );
    expect(direct).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(task, "chapter_count_exceeded", false);
  });
});

describe("home worker local video client", () => {
  const clipTask: HomeTask = {
    kind: "generate_clips",
    jobId: "33333333-3333-4333-8333-333333333333",
    leaseToken: "44444444-4444-4444-8444-444444444444",
    sceneIndex: 2,
    prompt: "a cat walks",
    negativePrompt: "logos",
    referenceUrl: "https://r2.example/plate",
    profile: { frames: 33, fps: 16, width: 480, height: 832, steps: 20 },
  };
  it("serves no video while Wan is disabled in model policy, even if configured", () => {
    expect(
      homeExecutorsFrom({
        LOCAL_VIDEO_ENABLED: "true",
        VIDEO_GEN_URL: "http://127.0.0.1:7861",
      }).video,
    ).toBeUndefined();
  });
  it("posts the generated clip as base64 with the server's scene index", async () => {
    const api = fakeApi(clipTask);
    const video = {
      generate: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "video/webm" as const,
        model: "local:wan2.2-ti2v-5b",
        seed: 1,
        provenance: { runtime: "stable-diffusion.cpp" },
      })),
    };
    const fetchImage = vi.fn(async () => new Uint8Array([9]));
    expect(await runHomeWorkerOnce(api, { video, fetchImage, ...noMedia })).toBe(true);
    expect(fetchImage).toHaveBeenCalledWith("https://r2.example/plate");
    expect(video.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a cat walks", profile: clipTask.profile }),
    );
    expect(api.result).toHaveBeenCalledWith(clipTask, {
      kind: "generate_clips",
      sceneIndex: 2,
      base64: "AQID",
      mimeType: "video/webm",
      model: "local:wan2.2-ti2v-5b",
      provenance: { runtime: "stable-diffusion.cpp" },
    });
  });
  it("reports a generator timeout as a retryable failure", async () => {
    const api = fakeApi(clipTask);
    const video = {
      generate: vi.fn(async () => {
        throw new Error("sdcpp_timeout");
      }),
    };
    await runHomeWorkerOnce(api, {
      video,
      fetchImage: async () => new Uint8Array([9]),
      ...noMedia,
    });
    expect(api.fail).toHaveBeenCalledWith(clipTask, "sdcpp_timeout", true);
    expect(api.result).not.toHaveBeenCalled();
  });
  it("retries a clip task when no video generator is configured", async () => {
    const api = fakeApi(clipTask);
    await runHomeWorkerOnce(api, noMedia);
    expect(api.fail).toHaveBeenCalledWith(clipTask, "video_generator_not_configured", true);
  });
});

describe("home worker runtime supervision", () => {
  it("fails a task retryably with runtime_unhealthy and reports heartbeats without argv", async () => {
    const api = { ...fakeApi(plateTask), heartbeat: vi.fn(async () => undefined) };
    const supervisor = {
      ensure: vi.fn(async () => {
        throw new Error("runtime_unhealthy");
      }),
      release: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      status: () => ({ busy: null, runtimes: { image_generation: "failed" as const } }),
    };
    const generator = { generate: vi.fn() };
    const context = {
      supervisor,
      capabilities: ["image_generation" as const],
      last: { completedAt: null, failureCode: null as string | null },
    };
    await runHomeWorkerOnce(api as unknown as HomeApi, { generator, ...noMedia } as never, context);
    expect(supervisor.ensure).toHaveBeenCalledWith("image_generation");
    expect(generator.generate).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(plateTask, "runtime_unhealthy", true);
    expect(supervisor.release).toHaveBeenCalledWith("image_generation");
    expect(api.heartbeat).toHaveBeenCalledWith({
      capabilities: ["image_generation"],
      busy: null,
      runtimes: { image_generation: "failed" },
      lastCompletedAt: null,
      lastFailureCode: null,
    });
    expect(context.last.failureCode).toBe("runtime_unhealthy");
  });
});

describe("servedCapabilities", () => {
  it("includes copywriting when only the copywriter executor is configured", () => {
    const copywriter = { writer: {}, model: "m" } as unknown as HomeExecutors["copywriter"];
    expect(servedCapabilities({ copywriter } as HomeExecutors, {})).toEqual(["copywriting"]);
    expect(servedCapabilities({} as HomeExecutors, {})).toEqual([]);
  });
});

describe("home worker auto-package scenes (D1/D2)", () => {
  const base = {
    jobId: "33333333-3333-4333-8333-333333333333",
    leaseToken: "44444444-4444-4444-8444-444444444444",
  };
  const sceneTask: HomeTask = {
    kind: "generate_offer_scenes",
    ...base,
    referenceUrls: ["https://r2/sheet", "https://r2/photo"],
    scenes: [
      { key: "1:feed", prompt: "Carla and the rack", seed: 11, size: { width: 512, height: 640 } },
    ],
  };
  const fidelityTask: HomeTask = {
    kind: "check_scene_fidelity",
    ...base,
    sceneUrl: "https://r2/scene",
    referenceUrl: "https://r2/photo",
    spec: { features: [{ key: "shelves", value: 3 }], forbiddenMutations: [] },
    offerTitle: "Estante 3 Prateleiras",
  };
  const fetchImage = vi.fn(async (url: string) =>
    url.endsWith("scene") ? new Uint8Array([0x89, 1]) : new Uint8Array([0xff, 2]),
  );

  it("configures the Klein editor only with LOCAL_AI_ENABLED and IMAGE_EDIT_URL", () => {
    const env = { IMAGE_EDIT_URL: "http://127.0.0.1:1234" };
    expect(homeExecutorsFrom(env).editor).toBeUndefined();
    expect(homeExecutorsFrom({ ...env, LOCAL_AI_ENABLED: "true" }).editor).toBeDefined();
    const fidelity = homeExecutorsFrom({ FRAME_REVIEWER_URL: "http://127.0.0.1:8081" }).fidelity;
    expect(fidelity?.compare).toBeDefined();
    // The listing-photo check (mode "reference") failed on every claim without it (2026-10-15).
    expect(fidelity?.reference).toBeDefined();
  });

  it("edits each scene from the references in order with the server's seed", async () => {
    const api = fakeApi(sceneTask);
    const edit = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png" as const,
      width: 512,
      height: 640,
      neurons: 0,
      model: "local:flux-2-klein-4b",
      seed: 11,
      provenance: { runtime: "stable-diffusion.cpp" },
    }));
    expect(await runHomeWorkerOnce(api, { editor: { edit }, fetchImage, ...noMedia })).toBe(true);
    expect(edit).toHaveBeenCalledWith(
      "Carla and the rack",
      [new Uint8Array([0xff, 2]), new Uint8Array([0xff, 2])],
      { width: 512, height: 640 },
      { seed: 11 },
    );
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([
      "https://r2/sheet",
      "https://r2/photo",
    ]);
    expect(api.result).toHaveBeenCalledWith(sceneTask, {
      kind: "generate_offer_scenes",
      scenes: [
        {
          key: "1:feed",
          base64: "AQID",
          model: "local:flux-2-klein-4b",
          seed: 11,
          provenance: { runtime: "stable-diffusion.cpp" },
          // The server checks it against the prompt it compiles at apply time.
          promptSha256: createHash("sha256").update("Carla and the rack").digest("hex"),
        },
      ],
    });
  });

  it("sends each scene's depth map when configured and the scene alone when depth fails", async () => {
    const edit = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png" as const,
      width: 512,
      height: 640,
      neurons: 0,
      model: "local:flux-2-klein-4b",
      seed: 11,
    }));
    const posted = async (depth: (scene: Uint8Array) => Promise<Uint8Array>) => {
      const api = fakeApi(sceneTask);
      await runHomeWorkerOnce(api, { editor: { edit }, depth, fetchImage, ...noMedia });
      const calls = api.result.mock.calls as unknown as [
        unknown,
        { scenes: Record<string, unknown>[] },
      ][];
      return calls[0]?.[1].scenes[0];
    };
    expect(await posted(async () => new Uint8Array([4, 5, 6]))).toMatchObject({
      key: "1:feed",
      depthBase64: "BAUG",
    });
    expect(
      await posted(async () => {
        throw new Error("uv missing");
      }),
    ).not.toHaveProperty("depthBase64");
    expect(homeExecutorsFrom({ DEPTH_MODEL_PATH: "/m/depth.onnx" }).depth).toBeDefined();
    expect(homeExecutorsFrom({ UPSCALE_EXE: "/e/realesrgan.exe" }).upscale).toBeDefined();
    expect(homeExecutorsFrom({}).depth).toBeUndefined();
  });

  it("posts the upscaled scene and its depth; posts the scene as drawn when upscaling fails", async () => {
    const edit = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png" as const,
      width: 512,
      height: 640,
      neurons: 0,
      model: "local:flux-2-klein-4b",
      seed: 11,
    }));
    const depth = vi.fn(async (scene: Uint8Array) => scene);
    const posted = async (upscale: (scene: Uint8Array) => Promise<Uint8Array>) => {
      const api = fakeApi(sceneTask);
      await runHomeWorkerOnce(api, { editor: { edit }, upscale, depth, fetchImage, ...noMedia });
      const calls = api.result.mock.calls as unknown as [
        unknown,
        { scenes: Record<string, unknown>[] },
      ][];
      return calls[0]?.[1].scenes[0];
    };
    expect(await posted(async () => new Uint8Array([4, 5, 6]))).toMatchObject({
      base64: "BAUG",
      depthBase64: "BAUG",
    });
    expect(
      await posted(async () => {
        throw new Error("vulkan lost");
      }),
    ).toMatchObject({ base64: "AQID" });
  });

  it("posts the raw VLM answer with photo first and scene second; no VLM retries", async () => {
    const api = fakeApi(fidelityTask);
    const compare = vi.fn(async () => ({ productPresent: true }));
    await runHomeWorkerOnce(api, {
      fidelity: { compare, model: "local:qwen3-vl-4b" },
      fetchImage,
      ...noMedia,
    });
    expect(compare).toHaveBeenCalledWith({
      reference: { bytes: new Uint8Array([0xff, 2]), mimeType: "image/jpeg" },
      scene: { bytes: new Uint8Array([0x89, 1]), mimeType: "image/png" },
      spec: fidelityTask.spec,
      offerTitle: "Estante 3 Prateleiras",
    });
    expect(api.result).toHaveBeenCalledWith(fidelityTask, {
      kind: "check_scene_fidelity",
      answer: { productPresent: true },
      model: "local:qwen3-vl-4b",
      provenance: { runtime: "llama.cpp" },
    });
    const idle = fakeApi(fidelityTask);
    await runHomeWorkerOnce(idle, { fetchImage, ...noMedia });
    expect(idle.fail).toHaveBeenCalledWith(fidelityTask, "fidelity_vlm_not_configured", true);
  });

  it("asks the reference question for a listing photo check (mode reference)", async () => {
    const task = { ...fidelityTask, mode: "reference" as const };
    const api = fakeApi(task);
    const compare = vi.fn();
    const reference = vi.fn(async () => ({ cleanProduct: true, extras: [], note: "" }));
    await runHomeWorkerOnce(api, {
      fidelity: { compare, reference, model: "local:qwen3-vl-4b" },
      fetchImage,
      ...noMedia,
    });
    expect(compare).not.toHaveBeenCalled();
    expect(reference).toHaveBeenCalledWith({
      photo: { bytes: new Uint8Array([0x89, 1]), mimeType: "image/png" },
      offerTitle: "Estante 3 Prateleiras",
    });
    expect(api.result).toHaveBeenCalledWith(task, {
      kind: "check_scene_fidelity",
      answer: { cleanProduct: true, extras: [], note: "" },
      model: "local:qwen3-vl-4b",
      provenance: { runtime: "llama.cpp" },
    });
    const old = fakeApi(task);
    await runHomeWorkerOnce(old, { fidelity: { compare, model: "m" }, fetchImage, ...noMedia });
    expect(old.fail).toHaveBeenCalledWith(task, "fidelity_reference_not_supported", true);
  });

  it("transcribes the Reel audio and posts the raw transcript", async () => {
    const narrationTask: HomeTask = {
      kind: "check_narration",
      ...base,
      videoUrl: "https://r2/reel.mp4",
      language: "pt-BR",
      lines: ["Por R$ 329,90."],
    };
    const api = fakeApi(narrationTask);
    const transcribe = vi.fn(async () => "Por R$ 329,90.");
    const fetchVideo = vi.fn(async () => new Uint8Array([7]));
    await runHomeWorkerOnce(api, {
      ...noMedia,
      fetchVideo,
      asr: { transcribe, model: "local:parakeet-tdt-0.6b-v3" },
    });
    expect(fetchVideo).toHaveBeenCalledWith("https://r2/reel.mp4");
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array([7]), "pt-BR");
    expect(api.result).toHaveBeenCalledWith(narrationTask, {
      kind: "check_narration",
      transcript: "Por R$ 329,90.",
      model: "local:parakeet-tdt-0.6b-v3",
      provenance: { runtime: "audio.cpp" },
    });
    const idle = fakeApi(narrationTask);
    await runHomeWorkerOnce(idle, noMedia);
    expect(idle.fail).toHaveBeenCalledWith(narrationTask, "asr_not_configured", true);
  });

  it("serves speech_recognition only with ASR_URL and an ASR model from policy", () => {
    const env = { ASR_URL: "http://127.0.0.1:8090" };
    expect(homeExecutorsFrom(env).asr?.model).toBe("local:parakeet-tdt-0.6b-v3");
    expect(homeExecutorsFrom({}).asr).toBeUndefined();
    expect(homeExecutorsFrom({ ...env, ASR_MODEL: "local:qwen3-vl-4b" }).asr).toBeUndefined();
    const asr = { transcribe: vi.fn(), model: "m" } as unknown as HomeExecutors["asr"];
    expect(servedCapabilities({ asr } as HomeExecutors, {})).toEqual(["speech_recognition"]);
  });

  it("advertises image_editing with an editor and visual_qa with the fidelity VLM", () => {
    const editor = { edit: vi.fn() } as unknown as HomeExecutors["editor"];
    const fidelity = { compare: vi.fn(), model: "m" } as unknown as HomeExecutors["fidelity"];
    expect(servedCapabilities({ editor, fidelity } as HomeExecutors, {})).toEqual([
      "visual_qa",
      "image_editing",
    ]);
    expect(servedCapabilities({} as HomeExecutors, { image_editing: {} })).toEqual([
      "image_editing",
    ]);
  });
});
