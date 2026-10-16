import {
  FRAME_REVIEW_JSON_SCHEMA,
  type FrameReviewer,
  VLM_ISSUE_KINDS,
} from "@money-maker/core/explainer/visual-qa/vlm-review";
import { chatTarget } from "./chat-target.js";

/**
 * Local frame reviewer on llama.cpp's llama-server started with `--mmproj` (OpenAI-compatible
 * /v1/chat/completions with an image_url part). Loopback only: llama-server has no
 * authentication. The reply is validated by `reviewFrames`, never trusted here.
 */
export type LlamaServerFrameReviewerOptions = Readonly<{
  baseUrl?: string;
  model: string;
  /** Cloud route through the Vercel AI Gateway instead of the local server. */
  gateway?: Readonly<{ apiKey: string }>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Spec target is <= 10 s per frame; the ceiling only stops a hung server. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 400;

export const localBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("frame_reviewer_url_not_local");
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK.has(url.hostname))
    throw new Error("frame_reviewer_url_not_local");
  return url.origin;
};

/** FRAME_REVIEWER_URL unset or blank means the VLM review is disabled. */
export const readFrameReviewerConfig = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ baseUrl: string; model: string }> | null => {
  const baseUrl = env.FRAME_REVIEWER_URL?.trim();
  if (!baseUrl) return null;
  return { baseUrl, model: env.FRAME_REVIEWER_MODEL?.trim() || "local" };
};

export const FRAME_REVIEW_SYSTEM_PROMPT = `You review one frame of a vertical stick-figure explainer video for visual craft only.
Judge only: ${VLM_ISSUE_KINDS.join(", ")}.
Never judge or repeat facts, numbers, prices, claims or the wording of any text; never suggest new content.
Reply with JSON {"verdict": "ok"|"issue", "issues": [...]} and nothing else. Use "ok" with an empty list when the frame reads clearly. Each issue has kind, severity (info|warn) and a note of at most 140 characters naming what to change. Report at most 4 issues, only real ones.`;

export const createLlamaServerFrameReviewer = (
  options: LlamaServerFrameReviewerOptions,
): FrameReviewer => {
  const target = chatTarget(options, localBaseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async review(frame) {
      const response = await doFetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify({
          model: target.model,
          messages: [
            { role: "system", content: FRAME_REVIEW_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: frame.hook
                    ? "This is the hook frame (also the thumbnail). Review it."
                    : "Review this frame.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: MAX_TOKENS,
          response_format: {
            type: "json_schema",
            json_schema: { name: "frame_review", schema: FRAME_REVIEW_JSON_SCHEMA },
          },
          ...target.extra,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`frame_reviewer_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new Error("frame_reviewer_response_invalid");
      if (choice?.finish_reason === "length") return content;
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    },
  };
};
