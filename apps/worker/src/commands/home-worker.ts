import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import { directScenes } from "@money-maker/core/content/direct-scenes";
import { directorPlanFrom } from "@money-maker/core/content/director-plan";
import {
  chapterCountIssue,
  chapterInput,
  splitChapters,
} from "@money-maker/core/content/long-form-direction";
import {
  draftOfferCopyWithCorrections,
  offerCopyHookCandidates,
} from "@money-maker/core/content/offer-copy";
import type { ProductVisualSpec } from "@money-maker/core/creatives/in-scene-fidelity";
import type { ImageEditor, SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import type { SceneDirector } from "@money-maker/core/explainer/scene-director";
import {
  type FrameReviewer,
  reviewFrames,
  type VlmFrame,
} from "@money-maker/core/explainer/visual-qa/vlm-review";
import type { HomeTask } from "@money-maker/core/home-worker/tasks";
import {
  CAPABILITY_JOBS,
  HOME_CAPABILITIES,
  type HomeCapability,
  type HomeWorkerHeartbeat,
} from "@money-maker/core/home-worker/tokens";
import { NARRATION_ASR_MODEL } from "@money-maker/core/publishing/narration-check";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { createLlamaServerArtDirector } from "@money-maker/providers/llm/llama-server-art-director";
import {
  type Copywriter,
  createLlamaServerCopywriter,
  readCopywriterConfig,
} from "@money-maker/providers/llm/llama-server-copywriter";
import {
  createLlamaServerFidelityVlm,
  type FidelityVlmImage,
} from "@money-maker/providers/llm/llama-server-fidelity-vlm";
import {
  createLlamaServerFrameReviewer,
  readFrameReviewerConfig,
} from "@money-maker/providers/llm/llama-server-frame-reviewer";
import {
  createLlamaServerSceneDirector,
  readSceneDirectorConfig,
} from "@money-maker/providers/llm/llama-server-scene-director";
import { createAudiocppClient } from "@money-maker/providers/media/audiocpp-client";
import { createCommandSceneGenerator } from "@money-maker/providers/media/command-scene-generator";
import { extractKeyFrames } from "@money-maker/providers/media/extract-key-frames";
import { createRealEsrganUpscaler } from "@money-maker/providers/media/realesrgan-upscaler";
import { runProcess } from "@money-maker/providers/media/run-process";
import {
  createSdCppImageEditor,
  createSdCppSceneGenerator,
} from "@money-maker/providers/media/sdcpp-scene-generator";
import {
  createSdCppVideoGenerator,
  type VideoGenerator,
} from "@money-maker/providers/media/sdcpp-video-generator";
import { startAgentLlmProxy } from "./agent-llm-proxy.js";
import {
  createRuntimeSupervisor,
  parseHomeRuntimes,
  type RuntimeSupervisor,
  spawnChild,
} from "./home-runtime.js";

/**
 * Home worker client (ADR 0012). Runs on a home machine with only HOME_WORKER_API_URL and
 * MONEY_MAKER_HOME_TOKEN: it claims a local-AI task from the API, runs the model step against local
 * servers, and posts the output. It never holds database or storage credentials.
 */
const execFileAsync = promisify(execFile);
// src/commands and dist/commands both sit four levels below the repository root.
const DEPTH_SCRIPT = fileURLToPath(
  new URL("../../../../scripts/local-ai/depth.py", import.meta.url),
);

/** Depth Anything V2 Small on the CPU through scripts/local-ai/depth.py (uv), about 1 s a scene. */
const depthMapper =
  (modelPath: string) =>
  async (scene: Uint8Array): Promise<Uint8Array> => {
    const dir = await mkdtemp(join(tmpdir(), "mm-depth-"));
    try {
      const file = join(dir, "scene.png");
      await writeFile(file, scene);
      await execFileAsync("uv", ["run", "-q", DEPTH_SCRIPT, "--model", modelPath, file], {
        timeout: 120_000,
      });
      return new Uint8Array(await readFile(join(dir, "scene.depth.png")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

/** audio.cpp ASR on the audio track of an MP4 (16 kHz mono WAV through ffmpeg). */
const audiocppTranscriber = (baseUrl: string, model: string): NonNullable<HomeExecutors["asr"]> => {
  const client = createAudiocppClient({ baseUrl });
  return {
    model,
    transcribe: async (video, language) => {
      const dir = await mkdtemp(join(tmpdir(), "mm-asr-"));
      try {
        const input = join(dir, "reel.mp4");
        const output = join(dir, "reel.wav");
        await writeFile(input, video);
        await runProcess(
          "ffmpeg",
          ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-y", output],
          { timeoutMs: 120_000 },
        );
        const wav = new Uint8Array(await readFile(output));
        return (await client.transcribe({ model, wav, language: language.split("-")[0] ?? "pt" }))
          .text;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};

export type HomeExecutors = Readonly<{
  director?: SceneDirector;
  generator?: SceneGenerator;
  /** Local copywriter (COPYWRITER_URL, loopback only) and the model id it runs. */
  copywriter?: Readonly<{ writer: Copywriter; model: string }>;
  /** Scene lines from the same copy model (scene-direction.ts); the server validates them. */
  artDirector?: ReturnType<typeof createLlamaServerArtDirector>;
  reviewer?: Readonly<{ reviewer: FrameReviewer; model: string }>;
  /** Reference editor for auto-package scenes (IMAGE_EDIT_URL, FLUX.2 Klein by default). */
  editor?: ImageEditor;
  /** In-scene product fidelity VLM (the FRAME_REVIEWER_URL Qwen3-VL server) and its model id. */
  fidelity?: Readonly<{
    compare: (input: {
      reference: FidelityVlmImage;
      scene: FidelityVlmImage;
      spec: ProductVisualSpec;
      offerTitle?: string;
    }) => Promise<unknown>;
    /** Listing photo alone: clean single product? (brief 11.1) */
    reference?: (input: { photo: FidelityVlmImage; offerTitle: string }) => Promise<unknown>;
    model: string;
  }>;
  /** Local image-to-video (VIDEO_GEN_URL, loopback/private only); absent while Wan is disabled. */
  video?: VideoGenerator;
  /** Real-ESRGAN x2 of each offer scene (UPSCALE_EXE); absent posts the scene as drawn. */
  upscale?: (scene: Uint8Array) => Promise<Uint8Array>;
  /** Relative depth map of a scene for 2.5D Reels (DEPTH_MODEL_PATH); absent sends none. */
  depth?: (scene: Uint8Array) => Promise<Uint8Array>;
  /** ASR for the Reel narration check (ASR_URL, loopback only) and the model id it runs. */
  asr?: Readonly<{
    /** Raw transcript of the audio track of an MP4. */
    transcribe: (video: Uint8Array, language: string) => Promise<string>;
    model: string;
  }>;
  /** Downloads a signed reference image (clip plate, character sheet, product photo, scene). */
  fetchImage?: (url: string) => Promise<Uint8Array>;
  fetchVideo: (url: string) => Promise<Uint8Array>;
  extractFrames: (video: Uint8Array, timesMs: readonly number[]) => Promise<readonly Uint8Array[]>;
}>;

export type HomeApi = Readonly<{
  /** `loaded`: the model already running, whose jobs the server hands out first. */
  claim(loaded?: HomeCapability): Promise<HomeTask | null>;
  result(task: HomeTask, result: unknown): Promise<void>;
  fail(task: HomeTask, reason: string, retryable: boolean): Promise<void>;
  heartbeat?(heartbeat: HomeWorkerHeartbeat): Promise<void>;
}>;

/** Runtime supervision and health reporting for one home machine (optional; tests omit it). */
export type HomeRuntimeContext = Readonly<{
  supervisor: Pick<RuntimeSupervisor, "ensure" | "release" | "stopAll" | "status">;
  capabilities: readonly HomeCapability[];
  last: { completedAt: string | null; failureCode: string | null };
}>;

const capabilityOf = (task: HomeTask): HomeCapability | undefined =>
  HOME_CAPABILITIES.find((capability) => CAPABILITY_JOBS[capability].includes(task.kind));

const sendHeartbeat = async (api: HomeApi, context?: HomeRuntimeContext): Promise<void> => {
  if (!context || !api.heartbeat) return;
  const { busy, runtimes } = context.supervisor.status();
  await api
    .heartbeat({
      capabilities: context.capabilities,
      busy,
      runtimes,
      lastCompletedAt: context.last.completedAt,
      lastFailureCode: context.last.failureCode,
    })
    .catch(() => undefined); // health reporting must never fail a round
};

class HomeStepError extends Error {
  public constructor(
    reason: string,
    public readonly retryable: boolean,
  ) {
    super(reason);
  }
}

const imageMime = (bytes: Uint8Array): string =>
  bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : "image/webp";

const runStep = async (executors: HomeExecutors, task: HomeTask): Promise<unknown> => {
  if (task.kind === "direct_scenes") {
    if (!executors.director) throw new HomeStepError("director_not_configured", true);
    if (task.longForm) {
      // One plan per chapter, in order; the server re-validates each and stitches them.
      const plans = [];
      const chapters = splitChapters(task.input.script.body, task.input.script.beats);
      if (chapterCountIssue(chapters.length))
        throw new HomeStepError("chapter_count_exceeded", false);
      for (const chapter of chapters) {
        const part = chapterInput(task.input, chapter);
        const done = await directScenes(executors.director, part);
        if (!done.ok) throw new HomeStepError(done.reason, done.reason === "director_unavailable");
        plans.push(directorPlanFrom(done.scenes, part.script.body));
      }
      return { kind: "direct_scenes", scenes: plans };
    }
    const outcome = await directScenes(executors.director, task.input);
    if (!outcome.ok)
      throw new HomeStepError(outcome.reason, outcome.reason === "director_unavailable");
    // The server parses a director plan (checkDirectorOutput), never compiled SceneSpecs.
    return {
      kind: "direct_scenes",
      scenes: directorPlanFrom(outcome.scenes, task.input.script.body),
    };
  }
  if (task.kind === "draft_offer_copy") {
    const copywriter = executors.copywriter;
    if (!copywriter) throw new HomeStepError("copywriter_not_configured", true);
    // Repair, validate and correct here with the same core checks and the task's verified facts
    // (a subset of the server's, so stricter); the server still re-checks what it receives.
    const context = {
      facts: task.input.offer.facts.map((fact) => ({ ...fact, sourceUrl: "", verified: true })),
      sourceFactKeys: task.validation?.sourceFactKeys ?? [],
      slideCount: task.input.slideCount,
      channels: task.input.channels,
      captionMaxLength: task.validation?.captionMaxLength ?? {},
      offerTitle: task.input.offer.title,
    };
    const outcome = await draftOfferCopyWithCorrections(
      (correction) => copywriter.writer.draft(task.input, correction),
      context,
    );
    // Provider failures and unusable output retry.
    if (!outcome.check) throw new HomeStepError("copy_not_json", true);
    if (!outcome.check.ok) throw new HomeStepError(`copy_rejected:${outcome.check.code}`, true);
    const { slides, captions } = outcome.check.repaired;
    // Only options that pass the same gates travel; the server checks them again.
    const hookOptions = offerCopyHookCandidates(outcome.check, outcome.raw, context)
      .slice(1)
      .map((candidate) => candidate.hook);
    // One scene line per slide from the same model; a failure costs nothing (server defaults).
    const sceneLines =
      task.artDirection && executors.artDirector
        ? await executors.artDirector
            .direct({
              ...task.artDirection,
              slides: slides.map((slide) => ({
                index: slide.index,
                template: slide.template,
                headline: slide.headline,
                body: slide.body,
              })),
            })
            .catch(() => undefined)
        : undefined;
    return {
      kind: "draft_offer_copy",
      draft: { slides, captions, ...(hookOptions.length > 0 ? { hookOptions } : {}) },
      ...(sceneLines !== undefined ? { sceneLines } : {}),
      model: copywriter.model,
      provenance: { runtime: "llama.cpp" },
    };
  }
  if (task.kind === "generate_clips") {
    if (!executors.video || !executors.fetchImage)
      throw new HomeStepError("video_generator_not_configured", true);
    const reference = await executors.fetchImage(task.referenceUrl);
    const clip = await executors.video.generate({
      prompt: task.prompt,
      negativePrompt: task.negativePrompt,
      reference,
      profile: task.profile,
    });
    return {
      kind: "generate_clips",
      sceneIndex: task.sceneIndex,
      base64: Buffer.from(clip.bytes).toString("base64"),
      mimeType: clip.mimeType,
      model: clip.model,
      provenance: clip.provenance,
    };
  }
  if (task.kind === "generate_offer_scenes") {
    if (!executors.editor || !executors.fetchImage)
      throw new HomeStepError("image_editor_not_configured", true);
    const fetchImage = executors.fetchImage;
    const references = await Promise.all(task.referenceUrls.map((url) => fetchImage(url)));
    const scenes = [];
    for (const scene of task.scenes) {
      const image = await executors.editor.edit(scene.prompt, references, scene.size, {
        seed: scene.seed,
      });
      if (!image.model) throw new HomeStepError("editor_model_missing", false);
      // Upscale and depth failures never cost the scene: it is posted as drawn, the Reel falls
      // back to Ken Burns.
      const bytes = (await executors.upscale?.(image.bytes).catch(() => undefined)) ?? image.bytes;
      const depth = await executors.depth?.(bytes).catch(() => undefined);
      scenes.push({
        key: scene.key,
        base64: Buffer.from(bytes).toString("base64"),
        model: image.model,
        seed: image.seed ?? scene.seed,
        ...(image.provenance ? { provenance: image.provenance } : {}),
        ...(depth ? { depthBase64: Buffer.from(depth).toString("base64") } : {}),
        promptSha256: createHash("sha256").update(scene.prompt).digest("hex"),
      });
    }
    return { kind: "generate_offer_scenes", scenes };
  }
  if (task.kind === "check_scene_fidelity") {
    if (!executors.fidelity || !executors.fetchImage)
      throw new HomeStepError("fidelity_vlm_not_configured", true);
    const [scene, reference] = await Promise.all(
      [task.sceneUrl, task.referenceUrl].map((url) => executors.fetchImage?.(url)),
    );
    if (!scene || !reference) throw new HomeStepError("fidelity_image_missing", true);
    if (task.mode === "reference" && !executors.fidelity.reference)
      throw new HomeStepError("fidelity_reference_not_supported", true);
    // The server validates the answer strictly and adds the colour evidence itself.
    const answer =
      task.mode === "reference" && executors.fidelity.reference
        ? await executors.fidelity.reference({
            photo: { bytes: scene, mimeType: imageMime(scene) },
            offerTitle: task.offerTitle,
          })
        : await executors.fidelity.compare({
            reference: { bytes: reference, mimeType: imageMime(reference) },
            scene: { bytes: scene, mimeType: imageMime(scene) },
            spec: task.spec,
            offerTitle: task.offerTitle,
          });
    return {
      kind: "check_scene_fidelity",
      answer,
      model: executors.fidelity.model,
      provenance: { runtime: "llama.cpp" },
    };
  }
  if (task.kind === "check_narration") {
    if (!executors.asr) throw new HomeStepError("asr_not_configured", true);
    const video = await executors.fetchVideo(task.videoUrl);
    // The server compares the raw transcript with the script; nothing is judged here.
    const transcript = await executors.asr.transcribe(video, task.language);
    return {
      kind: "check_narration",
      transcript,
      model: executors.asr.model,
      provenance: { runtime: "audio.cpp" },
    };
  }
  if (task.kind === "generate_plates") {
    const generator = executors.generator;
    if (!generator) throw new HomeStepError("generator_not_configured", true);
    const plates = [];
    for (const request of task.requests) {
      const image = await generator.generate(request.prompt, request.size);
      if (!image.model) throw new HomeStepError("generator_model_missing", false);
      plates.push({
        key: request.key,
        base64: Buffer.from(image.bytes).toString("base64"),
        model: image.model,
        ...(image.seed !== undefined ? { seed: image.seed } : {}),
        ...(image.provenance ? { provenance: image.provenance } : {}),
      });
    }
    return { kind: "generate_plates", plates };
  }
  if (!executors.reviewer) throw new HomeStepError("reviewer_not_configured", true);
  const video = await executors.fetchVideo(task.videoUrl);
  const pngs = await executors.extractFrames(
    video,
    task.frames.map((frame) => frame.timeMs),
  );
  const frames: VlmFrame[] = task.frames.flatMap((frame, index) => {
    const png = pngs[index];
    return png ? [{ sceneIndex: frame.sceneIndex, hook: frame.hook, png }] : [];
  });
  const review = await reviewFrames(executors.reviewer.reviewer, frames, {
    model: executors.reviewer.model,
  });
  return { kind: "review_frames", review };
};

/** One claim-run-post round. Returns false when the API had no task. */
export const runHomeWorkerOnce = async (
  api: HomeApi,
  executors: HomeExecutors,
  context?: HomeRuntimeContext,
) => {
  await sendHeartbeat(api, context);
  const loaded = context
    ? HOME_CAPABILITIES.find(
        (capability) => context.supervisor.status().runtimes[capability] === "healthy",
      )
    : undefined;
  const task = await api.claim(loaded);
  if (!task) return false;
  const capability = context ? capabilityOf(task) : undefined;
  let result: unknown;
  try {
    if (capability) await context?.supervisor.ensure(capability);
    result = await runStep(executors, task);
  } catch (error) {
    const retryable = error instanceof HomeStepError ? error.retryable : true;
    const reason = error instanceof Error ? error.message : "home_step_failed";
    console.error("home_task_failed", { jobId: task.jobId, kind: task.kind, reason });
    if (context)
      context.last.failureCode = /^[a-z0-9_:.-]{1,80}$/.test(reason) ? reason : "home_step_failed";
    await api.fail(task, reason, retryable);
    return true;
  } finally {
    if (capability) await context?.supervisor.release(capability);
  }
  await api.result(task, result);
  if (context) context.last.completedAt = new Date().toISOString();
  console.info("home_task_done", { jobId: task.jobId, kind: task.kind });
  await sendHeartbeat(api, context);
  return true;
};

const apiUrl = (value: string | undefined): URL => {
  if (!value) throw new Error("HOME_WORKER_API_URL is required.");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // The token is a bearer secret: plain HTTP only to a local API during development.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("HOME_WORKER_API_URL must use https.");
  return url;
};

export const createHomeApi = (
  base: URL,
  token: string,
  doFetch: typeof fetch = fetch,
  workerVersion?: string,
): HomeApi => {
  const post = async (path: string, body?: unknown) => {
    const response = await doFetch(new URL(path, base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    });
    if (response.status === 204) return null;
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = (payload as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(`home_api_${response.status}${detail ? `:${detail}` : ""}`);
    }
    return payload;
  };
  return {
    claim: async (loaded) =>
      (
        (await post("/v1/home-worker/claim", loaded ? { loaded } : undefined)) as {
          task: HomeTask;
        } | null
      )?.task ?? null,
    result: async (task, result) =>
      void (await post(`/v1/home-worker/tasks/${task.jobId}/result`, {
        leaseToken: task.leaseToken,
        result,
        ...(workerVersion ? { workerVersion } : {}),
      })),
    heartbeat: async (heartbeat) => void (await post("/v1/home-worker/heartbeat", heartbeat)),
    fail: async (task, reason, retryable) =>
      void (await post(`/v1/home-worker/tasks/${task.jobId}/fail`, {
        leaseToken: task.leaseToken,
        reason: reason.slice(0, 200),
        retryable,
      })),
  };
};

export const homeExecutorsFrom = (
  env: Readonly<Record<string, string | undefined>>,
): HomeExecutors => {
  const director = readSceneDirectorConfig(env);
  const reviewer = readFrameReviewerConfig(env);
  const copywriter = readCopywriterConfig(env);
  return {
    ...(copywriter && modelPolicyFor(copywriter.model)?.copywriting === true
      ? {
          copywriter: {
            writer: createLlamaServerCopywriter(copywriter),
            model: copywriter.model,
          },
          artDirector: createLlamaServerArtDirector(copywriter),
        }
      : {}),
    ...(director ? { director: createLlamaServerSceneDirector(director) } : {}),
    ...(env.LOCAL_AI_ENABLED === "true" && env.IMAGE_GEN_URL
      ? {
          generator: createSdCppSceneGenerator({
            baseUrl: env.IMAGE_GEN_URL,
            model: env.IMAGE_GEN_MODEL || "local:z-image-turbo",
            // One plate takes ~410 s on the desktop GPU (2026-10-05); the old 300 s default cut every one.
            timeoutMs: Number(env.LOCAL_AI_REQUEST_TIMEOUT_MS) || 900_000,
            maxBytes: Number(env.LOCAL_AI_MAX_IMAGE_BYTES) || 10_000_000,
            ...(env.IMAGE_GEN_STEPS ? { steps: Number(env.IMAGE_GEN_STEPS) } : {}),
          }),
        }
      : env.SCENE_GENERATOR_CMD && env.SCENE_GENERATOR_MODEL
        ? {
            generator: createCommandSceneGenerator({
              command: env.SCENE_GENERATOR_CMD,
              model: env.SCENE_GENERATOR_MODEL,
              machineKind: env.WORKER_MACHINE_KIND,
            }),
          }
        : {}),
    ...(env.LOCAL_VIDEO_ENABLED === "true" &&
    env.VIDEO_GEN_URL &&
    // Wan ships disabled in model policy: without owner promotion the machine serves no video.
    modelPolicyFor(env.VIDEO_GEN_MODEL || "local:wan2.2-ti2v-5b")?.enabled
      ? {
          video: createSdCppVideoGenerator({
            baseUrl: env.VIDEO_GEN_URL,
            model: env.VIDEO_GEN_MODEL || "local:wan2.2-ti2v-5b",
            timeoutMs: Number(env.LOCAL_AI_REQUEST_TIMEOUT_MS) || 300_000,
            maxBytes: Number(env.LOCAL_AI_MAX_VIDEO_BYTES) || 50_000_000,
            maxFrames: Number(env.LOCAL_AI_MAX_VIDEO_FRAMES) || 33,
          }),
        }
      : {}),
    ...(env.LOCAL_AI_ENABLED === "true" && env.IMAGE_EDIT_URL
      ? {
          editor: createSdCppImageEditor({
            baseUrl: env.IMAGE_EDIT_URL,
            model: env.IMAGE_EDIT_MODEL || "local:flux-2-klein-4b",
            timeoutMs: Number(env.LOCAL_AI_REQUEST_TIMEOUT_MS) || 900_000,
            maxBytes: Number(env.LOCAL_AI_MAX_IMAGE_BYTES) || 10_000_000,
            steps: Number(env.IMAGE_EDIT_STEPS) || 4,
            // 512 px references keep the 8 GB card alive (ErrorDeviceLost at 768+, 2026-10-06).
            referenceMaxSide: 512,
          }),
        }
      : {}),
    ...(reviewer
      ? {
          fidelity: (() => {
            const vlm = createLlamaServerFidelityVlm(reviewer);
            return { compare: vlm.compare, reference: vlm.reference, model: reviewer.model };
          })(),
        }
      : {}),
    ...(env.UPSCALE_EXE
      ? {
          upscale: createRealEsrganUpscaler({
            exe: env.UPSCALE_EXE,
            // CPU by default: the image editor holds most of the 8 GB card.
            gpu: Number(env.UPSCALE_GPU ?? -1),
          }),
        }
      : {}),
    ...(env.DEPTH_MODEL_PATH ? { depth: depthMapper(env.DEPTH_MODEL_PATH) } : {}),
    ...(env.ASR_URL && modelPolicyFor(env.ASR_MODEL || NARRATION_ASR_MODEL)?.capability === "asr"
      ? { asr: audiocppTranscriber(env.ASR_URL, env.ASR_MODEL || NARRATION_ASR_MODEL) }
      : {}),
    fetchImage: async (url: string) =>
      (
        await fetchSafeMedia(new URL(url), {
          maxBytes: 10_000_000,
          allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        })
      ).bytes,
    ...(reviewer
      ? { reviewer: { reviewer: createLlamaServerFrameReviewer(reviewer), model: reviewer.model } }
      : {}),
    fetchVideo: async (url) =>
      (
        await fetchSafeMedia(new URL(url), {
          maxBytes: 250_000_000,
          allowedMimeTypes: ["video/mp4"],
        })
      ).bytes,
    extractFrames: (video, times) => extractKeyFrames(video, times),
  };
};

/**
 * The token lives in the environment or in a local env file outside the repository (default
 * ~/.config/money-maker/home-worker.env), never on the command line. Like ssh keys, a file
 * other users can read is refused. Variables already set win over the file.
 */
export const readHomeEnvFile = (path: string): Record<string, string> | null => {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return null;
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    throw new Error(`${path} must not be readable by other users (chmod 600).`);
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
};

const loadHomeEnv = (): void => {
  const path =
    process.env.MONEY_MAKER_HOME_ENV_FILE ??
    join(homedir(), ".config", "money-maker", "home-worker.env");
  for (const [key, value] of Object.entries(readHomeEnvFile(path) ?? {}))
    process.env[key] ??= value;
};

/** The checkout's commit, recorded with each result; absent outside a git checkout. */
const workerVersion = (): string | undefined => {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .slice(0, 40);
  } catch {
    return undefined;
  }
};

/** Every capability the configured runtimes or executors can serve, copywriting included. */
export const servedCapabilities = (
  executors: HomeExecutors,
  runtimes: Readonly<Record<string, unknown>>,
): readonly HomeCapability[] =>
  HOME_CAPABILITIES.filter(
    (capability) =>
      capability in runtimes ||
      (capability === "scene_director" && executors.director) ||
      (capability === "image_generation" && executors.generator) ||
      (capability === "visual_qa" && (executors.reviewer || executors.fidelity)) ||
      (capability === "image_editing" && executors.editor) ||
      (capability === "video_generation" && executors.video) ||
      (capability === "copywriting" && executors.copywriter) ||
      (capability === "speech_recognition" && executors.asr),
  );

const main = async (): Promise<void> => {
  loadHomeEnv();
  const token = process.env.MONEY_MAKER_HOME_TOKEN?.trim();
  if (!token) throw new Error("MONEY_MAKER_HOME_TOKEN is required.");
  const api = createHomeApi(apiUrl(process.env.HOME_WORKER_API_URL), token, fetch, workerVersion());
  const executors = homeExecutorsFrom(process.env);
  const runtimes = parseHomeRuntimes(process.env.HOME_RUNTIMES);
  const supervisor = createRuntimeSupervisor({
    runtimes,
    spawn: spawnChild,
    fetch,
    now: Date.now,
    // unref: a pending idle timer must not keep the process alive after stopAll.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
    log: (event, fields) => console.info(event, fields),
  });
  const context: HomeRuntimeContext = {
    supervisor,
    capabilities: servedCapabilities(executors, runtimes),
    last: { completedAt: null, failureCode: null },
  };
  // The desktop's LLM for the VM's agents (plan D): only with a port, a token and the copy model.
  const agentPort = Number(process.env.AGENT_LLM_PORT);
  const agentToken = process.env.AGENT_LLM_TOKEN?.trim();
  const agentProxy =
    Number.isInteger(agentPort) && agentPort > 0 && agentToken && process.env.COPYWRITER_URL
      ? startAgentLlmProxy({
          port: agentPort,
          host: process.env.AGENT_LLM_HOST?.trim() || "127.0.0.1",
          supervisor,
          capability: "copywriting",
          upstream: new URL(process.env.COPYWRITER_URL).origin,
          token: agentToken,
          model: process.env.COPYWRITER_MODEL?.trim() || "local:qwen3.5-9b",
          log: (event, fields) => console.info(event, fields),
        })
      : null;
  const shutdown = () => {
    agentProxy?.close();
    void supervisor.stopAll().finally(() => process.exit());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const once = process.argv.includes("--once");
  const pollMs = Math.max(5_000, Number(process.env.HOME_WORKER_POLL_MS) || 30_000);
  for (;;) {
    let worked = false;
    try {
      worked = await runHomeWorkerOnce(api, executors, context);
    } catch (error) {
      console.error("home_worker_round_failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    if (once) return supervisor.stopAll();
    if (!worked) await sleep(pollMs);
  }
};

if (process.argv[1]?.endsWith("home-worker.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
