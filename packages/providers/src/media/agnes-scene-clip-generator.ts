import {
  type SceneClipGenerator,
  type SceneClipPoll,
  SceneClipSubmitError,
} from "@money-maker/core/assets/scene-clip-generator";

/**
 * Hosted Agnes adapter (spec 2026-09-30 generative scene clips, 1 and 4.1). Facts it encodes:
 * submit is POST /v1/videos, polling is GET /agnesapi?video_id= (HTTP 200 even on failure, status
 * in the body), task records can 404 for minutes after submit, upstream kills jobs at about 15
 * minutes. Only free models are callable (INV-G3): 2.5 Flash (default; free "for a limited time"
 * per wiki.agnes-ai.com/en/docs/pricing, list $0.025/s) and the retired v2.0 (still served on
 * 2026-10-01). The paid agnes-video-2.5 is refused.
 * The key goes only into the Authorization header; errors carry codes, never request data.
 */
export const AGNES_MODEL = "agnes-video-2.5-flash";
export const AGNES_LEGACY_MODEL = "agnes-video-v2.0";
const ALLOWED_MODELS: ReadonlySet<string> = new Set([AGNES_MODEL, AGNES_LEGACY_MODEL]);
const LEGACY_PORTRAIT = { width: 768, height: 1152 } as const;
const FRAME_RATE = 24;
const LEGACY_MAX_SECONDS = 17;
/** 2.5 Flash: seconds "4".."12" as a string, size 720P only, 9:16 returns 720x1280. */
const FLASH_MIN_SECONDS = 4;
const FLASH_MAX_SECONDS = 12;
const MAX_REFERENCE_IMAGES = 5;
const NOT_VISIBLE_MS = 10 * 60_000;
const UPSTREAM_KILL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** The v2.0 model only accepts 8n + 1 frames (API error seen in the A0 spike, 2026-10-01). */
const frameCount = (seconds: number): number =>
  8 * Math.max(1, Math.round((seconds * FRAME_RATE) / 8)) + 1;
const flashMode = (
  mode: "text" | "image" | "keyframes",
  images: readonly string[],
): Record<string, unknown> =>
  mode === "text"
    ? { mode: "text" }
    : mode === "keyframes" && images.length === 2
      ? { mode: "keyframe", first_frame: images[0], last_frame: images[1] }
      : { mode: "reference", images: [...images] };
const RETRYABLE_CODES = new Set(["video_queue_full", "upstream_timeout", "task_not_found"]);

/**
 * AGNES_MODEL env value for the worker. An unset, paid or unknown value falls back to the default
 * with a warning instead of failing the boot (a bad env must not take the whole worker down).
 */
export const resolveAgnesModel = (
  value: string | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): string => {
  if (value === undefined || value.trim() === "") return AGNES_MODEL;
  if (ALLOWED_MODELS.has(value.trim())) return value.trim();
  warn("agnes_model_not_allowed");
  return AGNES_MODEL;
};

export type AgnesSceneClipGeneratorOptions = Readonly<{
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  record(await response.json().catch(() => ({})));
const errorCode = (body: Record<string, unknown>): string | undefined => {
  const nested = record(body["error"])["code"];
  const code = typeof nested === "string" ? nested : body["code"];
  return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
};

export const createAgnesSceneClipGenerator = (
  options: AgnesSceneClipGeneratorOptions,
): SceneClipGenerator => {
  const model = options.model ?? AGNES_MODEL;
  if (!ALLOWED_MODELS.has(model)) throw new Error("agnes_model_not_allowed");
  const legacy = model === AGNES_LEGACY_MODEL;
  const baseUrl = (options.baseUrl ?? "https://apihub.agnes-ai.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  const send = (url: string, init: RequestInit): Promise<Response> =>
    doFetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  return {
    async submit(request) {
      const images = request.referenceImageUrls ?? [];
      const imagesValid =
        request.mode === "text"
          ? images.length === 0
          : request.mode === "image"
            ? images.length === 1
            : images.length >= 2 && images.length <= MAX_REFERENCE_IMAGES;
      if (!imagesValid) throw new SceneClipSubmitError("agnes_reference_images_invalid", false);
      if (
        legacy
          ? request.width !== LEGACY_PORTRAIT.width || request.height !== LEGACY_PORTRAIT.height
          : !(request.height > request.width)
      )
        throw new SceneClipSubmitError("agnes_portrait_only", false);
      const maxSeconds = legacy ? LEGACY_MAX_SECONDS : FLASH_MAX_SECONDS;
      if (!(request.seconds > 0) || request.seconds > maxSeconds)
        throw new SceneClipSubmitError("agnes_duration_invalid", false);
      const seed = request.seed !== undefined ? { seed: request.seed } : {};
      const requestBody = legacy
        ? {
            model,
            prompt: request.prompt,
            negative_prompt: request.negativePrompt,
            width: request.width,
            height: request.height,
            num_frames: frameCount(request.seconds),
            frame_rate: FRAME_RATE,
            ...seed,
            ...(images.length > 0 ? { images } : {}),
          }
        : {
            model,
            // 2.5 has no negative_prompt field; the locked negative block rides in the prompt.
            prompt: request.negativePrompt
              ? `${request.prompt}. Avoid: ${request.negativePrompt}`
              : request.prompt,
            ...flashMode(request.mode, images),
            seconds: String(
              Math.min(FLASH_MAX_SECONDS, Math.max(FLASH_MIN_SECONDS, Math.round(request.seconds))),
            ),
            size: "720P",
            aspect_ratio: "9:16",
            ...seed,
          };
      let response: Response;
      try {
        response = await send(`${baseUrl}/v1/videos`, {
          method: "POST",
          body: JSON.stringify(requestBody),
        });
      } catch {
        // The underlying error can echo request headers; only the code leaves this adapter.
        throw new SceneClipSubmitError("agnes_unreachable", true);
      }
      if (response.status === 401 || response.status === 403)
        throw new SceneClipSubmitError("unauthorized", false);
      // Free keys hit a per-minute limit after two or three quick submits (A0 spike).
      if (response.status === 429) throw new SceneClipSubmitError("rate_limited", true);
      if (response.status >= 500) {
        const code = errorCode(await readJson(response));
        throw new SceneClipSubmitError(code === "video_queue_full" ? code : "upstream_5xx", true);
      }
      const body = await readJson(response);
      // Poll with video_id: the task id ("task_…") answers 404 on /agnesapi (A0 spike, 2026-10-01).
      const id = [body["video_id"], body["task_id"], body["id"]].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (!response.ok || !id) {
        const code = errorCode(body);
        throw new SceneClipSubmitError(
          response.ok || !code ? "agnes_bad_response" : code,
          response.ok || code === "video_queue_full",
        );
      }
      return { providerTaskId: id, model, submittedAt: now().toISOString() };
    },

    async poll(task): Promise<SceneClipPoll> {
      const ageMs = task.submittedAt ? now().getTime() - Date.parse(task.submittedAt) : 0;
      const failed = (code: string): SceneClipPoll => ({
        status: "failed",
        code,
        retryable: RETRYABLE_CODES.has(code),
      });
      let response: Response;
      try {
        response = await send(
          `${baseUrl}/agnesapi?video_id=${encodeURIComponent(task.providerTaskId)}${
            task.model === AGNES_LEGACY_MODEL ? "" : `&model_name=${encodeURIComponent(task.model)}`
          }`,
          { method: "GET" },
        );
      } catch {
        // A network blip says nothing about the task: keep polling, never resubmit (INV-G4).
        return { status: "pending" };
      }
      if (response.status === 401 || response.status === 403) return failed("unauthorized");
      if (response.status === 404)
        return ageMs > NOT_VISIBLE_MS ? failed("task_not_found") : { status: "pending" };
      // Status queries are rate limited too ("too many video status queries"); wait, never fail.
      if (response.status === 429 || response.status >= 500) return { status: "pending" };
      const body = await readJson(response);
      switch (body["status"]) {
        case "completed": {
          const url = body["url"];
          return typeof url === "string" && url.length > 0
            ? { status: "completed", url }
            : { status: "failed", code: "agnes_bad_response", retryable: true };
        }
        case "failed":
          return failed(errorCode(body) ?? "provider_failed");
        case "pending":
        case "in_progress":
          return ageMs > UPSTREAM_KILL_MS ? failed("upstream_timeout") : { status: "pending" };
        default:
          return ageMs > UPSTREAM_KILL_MS ? failed("upstream_timeout") : { status: "pending" };
      }
    },
  };
};
