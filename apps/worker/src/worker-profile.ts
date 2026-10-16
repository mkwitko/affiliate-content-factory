// apps/worker/src/worker-profile.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RendererCapability } from "@money-maker/core/content/renderer-catalog";
import { type JobHandler, LOCAL_AI_JOB_NAMES } from "@money-maker/core/jobs/job";
import { staleReelRenderMs } from "@money-maker/core/publishing/reel-render";

export type WorkerProfile = "full" | "render_only" | "local_ai";
/** Model capabilities a local_ai worker can advertise (v2 spec 8); each one backs one job. */
export type LocalAiCapability = "scene_director" | "visual_qa" | "image_generation" | "upscale";
export const LOCAL_AI_CAPABILITIES: Readonly<Record<string, LocalAiCapability>> = {
  direct_scenes: "scene_director",
  review_frames: "visual_qa",
  generate_plates: "image_generation",
  upscale_assets: "upscale",
};
/**
 * Detected at boot, never declared (spec 10.2). Fonts and sharp are fatal checks in main.ts.
 * Renderer capability names come from the renderer catalog; scene_clips means AGNES_API_KEY is
 * set and the provider answered 200 to it at boot (clip spec 4.6). `verified` lists the model
 * capabilities whose files passed verify-models (local_ai only).
 */
export type Capabilities = Readonly<
  Record<RendererCapability, boolean> & { verified?: readonly LocalAiCapability[] }
>;

const RENDER_JOBS = [
  "render_creatives",
  "render_reel",
  "render_long_form",
  "render_owned_clip",
] as const;
// Waits on the network, not the CPU, so either profile may run it (not a heavy job).
const CLIP_JOBS = ["generate_scene_clips"] as const;
const PROFILE_JOBS: Readonly<Record<WorkerProfile, readonly string[]>> = {
  full: [
    "publish_content",
    "reconcile_publication",
    "produce_offer_package",
    ...RENDER_JOBS,
    ...CLIP_JOBS,
  ],
  render_only: [...RENDER_JOBS, ...CLIP_JOBS],
  // Exclusive: only a local_ai worker claims these, and it claims nothing else.
  local_ai: LOCAL_AI_JOB_NAMES,
};
const NEEDS: Readonly<Record<string, readonly RendererCapability[]>> = {
  render_reel: ["ffmpeg"],
  render_long_form: ["ffmpeg", "tts"],
  render_owned_clip: ["ffmpeg"],
  generate_scene_clips: ["scene_clips"],
};

/**
 * The handlers this worker registers, and therefore the only job names it claims. An explicit
 * WORKER_JOBS entry that cannot run fails the boot; without WORKER_JOBS a missing capability
 * drops the job silently, as a missing R2 or TTS_URL already did.
 */
export const selectHandlers = (input: {
  handlers: Readonly<Record<string, JobHandler>>;
  profile: WorkerProfile;
  jobs?: readonly string[] | undefined;
  capabilities: Capabilities;
}): Readonly<Record<string, JobHandler>> => {
  const allowed = PROFILE_JOBS[input.profile];
  const usable = (name: string) =>
    Object.hasOwn(input.handlers, name) &&
    (NEEDS[name] ?? []).every((capability) => input.capabilities[capability]) &&
    (!Object.hasOwn(LOCAL_AI_CAPABILITIES, name) ||
      (input.capabilities.verified ?? []).includes(
        LOCAL_AI_CAPABILITIES[name] as LocalAiCapability,
      ));
  for (const name of input.jobs ?? []) {
    if (!allowed.includes(name)) throw new Error(`worker_jobs_invalid:${name}`);
    if (!usable(name)) throw new Error(`worker_job_unavailable:${name}`);
  }
  const selected = Object.fromEntries(
    (input.jobs ?? allowed)
      .filter(usable)
      .map((name) => [name, input.handlers[name] as JobHandler]),
  );
  if (Object.keys(selected).length === 0) throw new Error("worker_no_jobs");
  return selected;
};

/**
 * Decision D4 (a restricted production role for home workers) is open, so a local_ai worker
 * boots only against a database on its own machine. Remove this when D4 is decided.
 */
export const assertLocalAiDatabase = (databaseUrl: string): void => {
  let local = false;
  try {
    const url = new URL(databaseUrl);
    // pg (pg-connection-string) lets `?host=` or `?hostaddr=` override the URL host, so any
    // host-like query parameter is refused, not just a remote hostname (D4 boundary).
    const overrides = [...url.searchParams.keys()].some((key) =>
      ["host", "hostaddr"].includes(key.toLowerCase()),
    );
    local =
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      !overrides &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    // fall through to the refusal
  }
  if (!local) throw new Error("worker_local_ai_requires_local_database");
};

const execFileAsync = promisify(execFile);
const TTS_PROBE_INTERVAL_MS = 2_000;

const AGNES_BASE_URL = "https://apihub.agnes-ai.com";
const AGNES_PROBE_TIMEOUT_MS = 5_000;

/** The key never leaves the Authorization header; any failure reads as "not available". */
const probeSceneClips = async (apiKey: string | undefined, doFetch: typeof fetch) => {
  if (!apiKey) return false;
  try {
    const response = await doFetch(new URL("/v1/models", AGNES_BASE_URL), {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(AGNES_PROBE_TIMEOUT_MS),
    });
    return response.status === 200;
  } catch {
    return false;
  }
};

export const detectCapabilities = async (input: {
  ttsUrl?: string | undefined;
  agnesApiKey?: string | undefined;
  probeBinary?: (name: "ffmpeg" | "ffprobe") => Promise<unknown>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  ttsWaitMs?: number;
}): Promise<Capabilities> => {
  const probe = input.probeBinary ?? ((name) => execFileAsync(name, ["-version"]));
  const ffmpeg = await Promise.all([probe("ffmpeg"), probe("ffprobe")]).then(
    () => true,
    () => false,
  );
  const doFetch = input.fetch ?? fetch;
  const scene_clips = await probeSceneClips(input.agnesApiKey, doFetch);
  if (!input.ttsUrl) return { ffmpeg, tts: false, scene_clips };
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  // Kokoro loads its model after the container starts; a bounded wait keeps a cold start from
  // dropping render_long_form for the life of the process. Any answer below 500 means it is up.
  // ponytail: detected once at boot; a TTS that dies later fails jobs at run time, as today.
  const attempts = Math.max(1, Math.ceil((input.ttsWaitMs ?? 120_000) / TTS_PROBE_INTERVAL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reachable = await doFetch(new URL("/v1/audio/voices", input.ttsUrl), {
      signal: AbortSignal.timeout(TTS_PROBE_INTERVAL_MS),
    }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (reachable) return { ffmpeg, tts: true, scene_clips };
    if (attempt < attempts - 1) await sleep(TTS_PROBE_INTERVAL_MS);
  }
  return { ffmpeg, tts: false, scene_clips };
};

/**
 * The API requeues a reel render still pending after staleReelRenderMs. A longer lease would let
 * that reset fire while this worker is still rendering, so refuse the combination at boot.
 */
export const assertLeaseFitsReelReset = (input: {
  jobs: readonly string[];
  leaseDurationMs: number;
}): void => {
  if (input.jobs.includes("render_reel") && input.leaseDurationMs > staleReelRenderMs)
    throw new Error(`worker_lease_exceeds_reel_reset:${input.leaseDurationMs}`);
};
