import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RENDER_TEMP_PREFIX } from "@money-maker/providers/media/ffmpeg-reel-renderer";

export type RenderLimits = Readonly<{
  leaseDurationMs: number;
  /** Deadline for heavy render jobs (HEAVY_JOB_NAMES). */
  heavyJobTimeoutMs: number;
  /**
   * Deadline for render_long_form alone (LONG_FORM_JOB_TIMEOUT_MS). Absent keeps the heavy
   * deadline: long-form is chunked, and finished chunks survive a timeout, so raising this is an
   * explicit choice made from a measured bench (`pnpm render-bench:long`), never a default.
   */
  longFormJobTimeoutMs?: number;
  /** Process priority for the worker and the encoders it spawns (0 normal, 19 lowest). */
  nice: number;
  /** Caps ffmpeg -threads and sharp concurrency; absent lets each decide. */
  threads?: number;
  /** STICKMAN_LAYER_CACHE=1: cached static layers in stickman_motion renders (v2 slice 17). */
  layerCache?: boolean;
  /** Deadline for local-AI jobs; set only for the local_ai profile. */
  localAiJobTimeoutMs?: number;
}>;

/** A job must finish, record its outcome and release its lease before another worker may claim it. */
const DEFAULT_LEASE_MS = 900_000;
const LEASE_MARGIN_MS = 60_000;

const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error("render_limits_invalid");
  return parsed;
};

export const readRenderLimits = (
  env: Readonly<Record<string, string | undefined>>,
): RenderLimits => {
  // Per worker process, hence per profile. No heartbeat: the deadline must end the render, and
  // leave a minute to record its outcome, before the lease lets another worker reclaim the job.
  const leaseDurationMs = integer(env.WORKER_LEASE_MS, DEFAULT_LEASE_MS, 120_000, 3_660_000);
  const heavyJobTimeoutMs = integer(env.RENDER_JOB_TIMEOUT_MS, 720_000, 10_000, 3_600_000);
  if (heavyJobTimeoutMs + LEASE_MARGIN_MS > leaseDurationMs)
    throw new Error("render_job_timeout_exceeds_lease");
  const longFormJobTimeoutMs =
    env.LONG_FORM_JOB_TIMEOUT_MS === undefined
      ? undefined
      : integer(env.LONG_FORM_JOB_TIMEOUT_MS, 0, 10_000, 3_600_000);
  if (
    longFormJobTimeoutMs !== undefined &&
    longFormJobTimeoutMs + LEASE_MARGIN_MS > leaseDurationMs
  )
    throw new Error("render_job_timeout_exceeds_lease");
  const nice = integer(env.WORKER_NICE, 10, 0, 19);
  const threads =
    env.RENDER_THREADS === undefined ? undefined : integer(env.RENDER_THREADS, 0, 1, 64);
  // v2 slice 17: cached static layers for stickman renders; off unless B2 says otherwise.
  const cache = env.STICKMAN_LAYER_CACHE?.trim() ?? "";
  if (!["", "0", "1", "false", "true"].includes(cache)) throw new Error("render_limits_invalid");
  const layerCache = cache === "1" || cache === "true";
  return {
    leaseDurationMs,
    heavyJobTimeoutMs,
    ...(longFormJobTimeoutMs !== undefined ? { longFormJobTimeoutMs } : {}),
    nice,
    ...(threads !== undefined ? { threads } : {}),
    ...(layerCache ? { layerCache } : {}),
  };
};

export type LocalAiLimits = Readonly<{
  leaseDurationMs: number;
  /** Deadline for LOCAL_AI_JOB_NAMES jobs. */
  localAiJobTimeoutMs: number;
}>;

/**
 * The local_ai profile has its own lease (model loads are slow) and ignores WORKER_LEASE_MS, so
 * a render lease can never be applied to it by accident. Same rule as renders: no heartbeat, so
 * the deadline ends the job and leaves a minute to record the outcome before the lease expires.
 */
export const readLocalAiLimits = (
  env: Readonly<Record<string, string | undefined>>,
): LocalAiLimits => {
  const leaseDurationMs = integer(env.LOCAL_AI_LEASE_MS, 1_800_000, 120_000, 7_260_000);
  const localAiJobTimeoutMs = integer(env.LOCAL_AI_JOB_TIMEOUT_MS, 1_500_000, 10_000, 7_200_000);
  if (localAiJobTimeoutMs + LEASE_MARGIN_MS > leaseDurationMs)
    throw new Error("local_ai_job_timeout_exceeds_lease");
  return { leaseDurationMs, localAiJobTimeoutMs };
};

/**
 * Removes render temp directories a killed worker left behind (a SIGKILL skips `finally`).
 * Only names with the shared render prefix, only when older than the cutoff, so a render in
 * another process on the same host is never touched.
 */
export const sweepRenderTemp = async (input: {
  root: string;
  olderThanMs: number;
  now?: number;
}): Promise<readonly string[]> => {
  const now = input.now ?? Date.now();
  const removed: string[] = [];
  for (const name of await readdir(input.root).catch(() => [])) {
    if (!name.startsWith(RENDER_TEMP_PREFIX)) continue;
    const path = join(input.root, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs < input.olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
};
