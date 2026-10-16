import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { LOCAL_GENERATOR_LICENSES } from "@money-maker/core/assets/asset";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import type { ImageEditor, SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import sharp from "sharp";
import { reencodeImage } from "../http/fit-image.js";

/** Default longest side for reference images: each adds tokens to every step, and large ones
 * made the RX 6650 XT lose the device (Vulkan ErrorDeviceLost, 2026-10-06). */
const MAX_REFERENCE_SIDE = 768;

type Options = Readonly<{
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxBytes?: number;
  pollMs?: number;
  /** Sampling steps per image (e.g. 8 for Z-Image-Turbo); unset keeps the server default. */
  steps?: number;
  /** sd.cpp diffusion-step cache for DiT models (docs/caching.md); unset keeps it off. */
  cacheMode?: (typeof SDCPP_CACHE_MODES)[number];
  /** Longest side references are shrunk to (256-1024, default 768). */
  referenceMaxSide?: number;
  /**
   * Benchmark only (arena): a registered, disabled challenger may run, and a weights licence
   * still under verification ("unknown") is allowed. Outputs never leave the bench directory.
   */
  arena?: boolean;
  fetch?: typeof fetch;
}>;

export const SDCPP_CACHE_MODES = [
  "easycache",
  "dbcache",
  "taylorseer",
  "cache-dit",
  "spectrum",
] as const;

export const localOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("sdcpp_url_not_local");
  }
  const host = url.hostname;
  if (
    url.protocol !== "http:" ||
    !(
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    )
  )
    throw new Error("sdcpp_url_not_local");
  return url.origin;
};

export const limitedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("sdcpp_response_invalid");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("sdcpp_response_too_large");
      chunks.push(part.value);
    }
    try {
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } catch {
      throw new Error("sdcpp_response_invalid");
    }
  } finally {
    reader.releaseLock();
  }
};

export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

type References = Uint8Array | readonly Uint8Array[];
type Generator = Readonly<{
  generate(
    prompt: string,
    size?: Readonly<{ width: number; height: number }>,
    options?: Readonly<{ reference?: References; seed?: number }>,
  ): ReturnType<SceneGenerator["generate"]>;
}>;

const createSdcppGenerator = (
  options: Options,
  capability: "image_generation" | "image_editing",
): Generator => {
  const origin = localOrigin(options.baseUrl);
  const policy = modelPolicyFor(options.model);
  const allowed = options.arena
    ? policy?.licensePolicy === "commercial_allowed" || policy?.licensePolicy === "unknown"
    : Boolean(LOCAL_GENERATOR_LICENSES[options.model]) && policy?.enabled;
  if (!allowed || policy?.capability !== capability) throw new Error("sdcpp_model_not_allowed");
  const doFetch = options.fetch ?? fetch;
  const referenceSide = options.referenceMaxSide ?? MAX_REFERENCE_SIDE;
  if (!Number.isInteger(referenceSide) || referenceSide < 256 || referenceSide > 1024)
    throw new Error("sdcpp_limits_invalid");
  const maxBytes = Math.min(options.maxBytes ?? 10_000_000, 10_000_000);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 1_000;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1_000_000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10_000 ||
    timeoutMs > 3_600_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 10_000 ||
    (options.steps !== undefined &&
      (!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 100)) ||
    (options.cacheMode !== undefined && !SDCPP_CACHE_MODES.includes(options.cacheMode))
  )
    throw new Error("sdcpp_limits_invalid");
  return {
    async generate(prompt, size, generateOptions) {
      const given = generateOptions?.reference;
      const reference = given && !(given instanceof Uint8Array) ? given : given ? [given] : null;
      if (reference && (reference.length < 1 || reference.length > 4))
        throw new Error("sdcpp_reference_invalid");
      if (capability === "image_generation" && reference)
        throw new Error("sdcpp_reference_requires_edit_capability");
      if (capability === "image_editing" && !reference) throw new Error("sdcpp_reference_required");
      const width = size?.width ?? 1024;
      const height = size?.height ?? 1024;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 512 ||
        height < 512 ||
        width > 4096 ||
        height > 4096
      )
        throw new Error("sdcpp_image_size_invalid");
      if (!prompt.trim() || prompt.length > 8_000) throw new Error("sdcpp_prompt_invalid");
      const pinned = generateOptions?.seed;
      if (
        pinned !== undefined &&
        (!Number.isInteger(pinned) || pinned < 0 || pinned > 2_147_483_646)
      )
        throw new Error("sdcpp_seed_invalid");
      const signal = AbortSignal.timeout(timeoutMs);
      const request = async (path: string, init: RequestInit = {}) => {
        try {
          const response = await doFetch(`${origin}${path}`, {
            ...init,
            signal,
            redirect: "error",
          });
          if (!response.ok) throw new Error(`sdcpp_http_${response.status}`);
          return limitedJson(response, Math.ceil(maxBytes * 1.4) + 4096);
        } catch (error) {
          // The abort surfaces as a DOMException; report the deadline, not a generic failure.
          if (signal.aborted) throw new Error("sdcpp_timeout");
          throw error;
        }
      };
      const capabilities = record(await request("/sdcpp/v1/capabilities"));
      if (
        !Array.isArray(capabilities?.supported_modes) ||
        !capabilities.supported_modes.includes("img_gen")
      )
        throw new Error("sdcpp_image_unavailable");
      const seed =
        pinned ?? createHash("sha256").update(prompt).digest().readUInt32BE(0) % 2_147_483_647;
      const cleanReferences = await Promise.all(
        (reference ?? []).map((image) =>
          reencodeImage(image)
            .then(async (clean) => ({
              bytes: new Uint8Array(
                await sharp(clean.bytes)
                  .resize({
                    width: referenceSide,
                    height: referenceSide,
                    fit: "inside",
                    withoutEnlargement: true,
                  })
                  .png()
                  .toBuffer(),
              ),
            }))
            .catch(() => null),
        ),
      );
      if (cleanReferences.some((clean) => !clean || clean.bytes.byteLength > maxBytes))
        throw new Error("sdcpp_reference_invalid");
      const submitted = record(
        await request("/sdcpp/v1/img_gen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            width,
            height,
            seed,
            ...(cleanReferences.length
              ? {
                  ref_images: cleanReferences.map((clean) =>
                    Buffer.from(clean?.bytes ?? []).toString("base64"),
                  ),
                }
              : {}),
            ...(options.steps ? { sample_params: { sample_steps: options.steps } } : {}),
            ...(options.cacheMode ? { cache_mode: options.cacheMode } : {}),
            batch_count: 1,
            output_format: "png",
          }),
        }),
      );
      const id = submitted?.id;
      if (typeof id !== "string" || !/^job_[A-Za-z0-9_-]{1,100}$/.test(id))
        throw new Error("sdcpp_job_invalid");
      let success = false;
      try {
        while (!signal.aborted) {
          const job = record(await request(`/sdcpp/v1/jobs/${id}`));
          if (job?.status === "completed") {
            const result = record(job.result);
            const images = result?.images;
            const image = Array.isArray(images) && images.length === 1 ? record(images[0]) : null;
            if (
              result?.output_format !== "png" ||
              typeof image?.b64_json !== "string" ||
              image.b64_json.length > Math.ceil((maxBytes * 4) / 3) + 8
            )
              throw new Error("sdcpp_image_invalid");
            const bytes = Buffer.from(image.b64_json, "base64");
            if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
              throw new Error("sdcpp_image_invalid");
            const clean = await reencodeImage(bytes).catch(() => null);
            if (
              !clean ||
              clean.bytes.byteLength > maxBytes ||
              clean.mimeType !== "image/png" ||
              clean.width !== width ||
              clean.height !== height
            )
              throw new Error("sdcpp_image_invalid");
            success = true;
            const observedModel = record(capabilities.model)?.name;
            return {
              ...clean,
              neurons: 0,
              model: options.model,
              license: `${policy?.license} (${options.model}, local)`,
              seed,
              provenance: {
                runtime: "stable-diffusion.cpp",
                ...(typeof observedModel === "string"
                  ? { observedModel: observedModel.slice(0, 120) }
                  : {}),
              },
            };
          }
          if (job?.status === "failed" || job?.status === "cancelled") {
            // The runtime's own reason (no request data) rides as the cause for benches and logs.
            const reason = record(job.error)?.message;
            throw new Error("sdcpp_job_failed", {
              cause: typeof reason === "string" ? reason.slice(0, 200) : undefined,
            });
          }
          if (job?.status !== "queued" && job?.status !== "generating")
            throw new Error("sdcpp_job_invalid");
          await sleep(pollMs, undefined, { signal }).catch(() => undefined);
        }
        throw new Error("sdcpp_timeout");
      } finally {
        if (!success)
          await doFetch(`${origin}/sdcpp/v1/jobs/${id}/cancel`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(3_000),
          }).catch(() => undefined);
      }
    },
  };
};

export const createSdCppSceneGenerator = (options: Options): SceneGenerator =>
  createSdcppGenerator(options, "image_generation");

export const createSdCppImageEditor = (options: Options): ImageEditor => {
  const generator = createSdcppGenerator(options, "image_editing");
  return {
    edit: (prompt, referenceImage, size, options) =>
      generator.generate(prompt, size, {
        reference: referenceImage,
        ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      }),
  };
};
