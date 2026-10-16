import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isLocalClipProfile,
  type LocalClipProfile,
} from "@money-maker/core/assets/local-clip-profile";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import { reencodeImage } from "../http/fit-image.js";
import { limitedJson, localOrigin, record } from "./sdcpp-scene-generator.js";

/**
 * Image-to-video against a local stable-diffusion.cpp server (native async API:
 * /sdcpp/v1/capabilities, /vid_gen, /jobs/{id}, /jobs/{id}/cancel). Request fields used, from the
 * server's api.md: prompt, negative_prompt, width, height, seed, video_frames, fps, init_image
 * (base64), sample_params.sample_steps, output_format "webm". Completed jobs return
 * result.b64_json (whole container), result.mime_type, result.frame_count. ASSUMPTION: a build
 * without WebM support answers 400; the home machine then reports a retryable failure.
 */
export type VideoGenerator = Readonly<{
  generate(input: {
    prompt: string;
    negativePrompt: string;
    /** The approved owned plate, any image format; re-encoded before it is sent. */
    reference: Uint8Array;
    profile: LocalClipProfile;
    seed?: number;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: "video/webm";
    model: string;
    seed: number;
    provenance: Readonly<{ runtime: string; observedModel?: string }>;
  }>;
}>;

export type VideoGeneratorOptions = Readonly<{
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxFrames?: number;
  pollMs?: number;
  fetch?: typeof fetch;
  /** Benchmarks only: lets a model that model policy still keeps disabled run. */
  allowDisabled?: boolean;
}>;

export const createSdCppVideoGenerator = (options: VideoGeneratorOptions): VideoGenerator => {
  const origin = localOrigin(options.baseUrl);
  const policy = modelPolicyFor(options.model);
  if (policy?.capability !== "video_generation" || !(policy.enabled || options.allowDisabled))
    throw new Error("sdcpp_model_not_allowed");
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 50_000_000;
  const maxFrames = options.maxFrames ?? 33;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 2_000;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1_000_000 ||
    maxBytes > 100_000_000 ||
    !Number.isInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 33 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10_000 ||
    timeoutMs > 3_600_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 10_000
  )
    throw new Error("sdcpp_limits_invalid");
  return {
    async generate({ prompt, negativePrompt, reference, profile, seed: pinned }) {
      if (!isLocalClipProfile(profile) || profile.frames > maxFrames)
        throw new Error("sdcpp_video_profile_invalid");
      if (!prompt.trim() || prompt.length > 8_000 || negativePrompt.length > 8_000)
        throw new Error("sdcpp_prompt_invalid");
      if (
        pinned !== undefined &&
        (!Number.isInteger(pinned) || pinned < 0 || pinned > 2_147_483_646)
      )
        throw new Error("sdcpp_seed_invalid");
      const signal = AbortSignal.timeout(timeoutMs);
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await doFetch(`${origin}${path}`, { ...init, signal, redirect: "error" });
        if (!response.ok) throw new Error(`sdcpp_http_${response.status}`);
        return limitedJson(response, Math.ceil(maxBytes * 1.4) + 4096);
      };
      const capabilities = record(await request("/sdcpp/v1/capabilities"));
      if (
        !Array.isArray(capabilities?.supported_modes) ||
        !capabilities.supported_modes.includes("vid_gen")
      )
        throw new Error("sdcpp_video_unavailable");
      const clean = await reencodeImage(reference).catch(() => null);
      if (!clean || clean.bytes.byteLength > 10_000_000) throw new Error("sdcpp_reference_invalid");
      const seed =
        pinned ?? createHash("sha256").update(prompt).digest().readUInt32BE(0) % 2_147_483_647;
      const submitted = record(
        await request("/sdcpp/v1/vid_gen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            negative_prompt: negativePrompt,
            width: profile.width,
            height: profile.height,
            seed,
            video_frames: profile.frames,
            fps: profile.fps,
            init_image: Buffer.from(clean.bytes).toString("base64"),
            sample_params: { sample_steps: profile.steps },
            output_format: "webm",
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
            const encoded = result?.b64_json;
            if (
              result?.output_format !== "webm" ||
              result.mime_type !== "video/webm" ||
              typeof encoded !== "string" ||
              encoded.length > Math.ceil((maxBytes * 4) / 3) + 8
            )
              throw new Error("sdcpp_video_invalid");
            const bytes = Buffer.from(encoded, "base64");
            if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
              throw new Error("sdcpp_video_invalid");
            success = true;
            const observedModel = record(capabilities.model)?.name;
            return {
              bytes,
              mimeType: "video/webm" as const,
              model: options.model,
              seed,
              provenance: {
                runtime: "stable-diffusion.cpp",
                ...(typeof observedModel === "string"
                  ? { observedModel: observedModel.slice(0, 120) }
                  : {}),
              },
            };
          }
          if (job?.status === "failed" || job?.status === "cancelled")
            throw new Error("sdcpp_job_failed");
          if (job?.status !== "queued" && job?.status !== "generating")
            throw new Error("sdcpp_job_invalid");
          await sleep(pollMs, undefined, { signal });
        }
        throw new Error("sdcpp_timeout");
      } catch (error) {
        // A timeout surfaces as an abort/timeout DOMException from fetch or sleep.
        if (signal.aborted) throw new Error("sdcpp_timeout");
        throw error;
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
