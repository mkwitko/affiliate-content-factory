import {
  buildOfferCopyMessages,
  COPY_CAPTION_MAX_CHARS,
  MAX_HOOK_OPTIONS,
  OFFER_COPY_CHANNELS,
  OFFER_COPY_SLIDE_RANGE,
  type OfferCopyCorrection,
  type OfferCopyDraft,
  type OfferCopyInput,
  TEMPLATE_IDS,
} from "@money-maker/core/content/offer-copy";
import { MAX_VOICE_LINE_LENGTH } from "@money-maker/core/creatives/slide-spec";
import { chatTarget } from "./chat-target.js";

/**
 * Local copywriter on llama.cpp's llama-server (OpenAI-compatible /v1/chat/completions), loopback
 * only like the scene director. The reply is JSON constrained by response_format and is still
 * re-validated by the server (validateOfferCopyDraft); this adapter only transports it.
 */
export type LlamaServerCopywriterOptions = Readonly<{
  baseUrl?: string;
  model: string;
  /** Cloud route through the Vercel AI Gateway instead of the local server. */
  gateway?: Readonly<{ apiKey: string }>;
  timeoutMs?: number;
  temperature?: number;
  fetch?: typeof fetch;
}>;

export interface Copywriter {
  /** Raw model output: the caller validates it. A correction carries the previous draft's problems. */
  draft(input: OfferCopyInput, correction?: OfferCopyCorrection): Promise<unknown>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TOKENS = 3_000;

export const localBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("copywriter_url_not_local");
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK.has(url.hostname))
    throw new Error("copywriter_url_not_local");
  return url.origin;
};

/** COPYWRITER_URL unset or blank means local copywriting is disabled. */
export const readCopywriterConfig = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ baseUrl: string; model: string; timeoutMs?: number }> | null => {
  const baseUrl = env.COPYWRITER_URL?.trim();
  if (!baseUrl) return null;
  const timeout = Number(env.COPYWRITER_TIMEOUT_MS);
  return {
    baseUrl,
    // Must be a server-policy scene_director model id; copy is accepted/served only if that entry has `copywriting: true`.
    model: env.COPYWRITER_MODEL?.trim() || "local:qwen3.5-9b",
    ...(Number.isInteger(timeout) && timeout >= 10_000 && timeout <= 3_600_000
      ? { timeoutMs: timeout }
      : {}),
  };
};

const slideJsonSchema = (factKeys: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["index", "total", "template", "headline", "claims"],
  properties: {
    index: { type: "integer", minimum: 1, maximum: 7 },
    total: { type: "integer", minimum: OFFER_COPY_SLIDE_RANGE.min, maximum: 7 },
    template: { enum: [...TEMPLATE_IDS] },
    headline: { type: "string", maxLength: 60 },
    body: { type: "string", maxLength: 140 },
    badge: { type: "string", maxLength: 40 },
    voiceLine: { type: "string", maxLength: MAX_VOICE_LINE_LENGTH },
    claims: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", maxLength: 120 },
          // Only keys of verified facts in the packet; no facts means no factKey at all.
          ...(factKeys.length > 0 ? { factKey: { enum: [...factKeys] } } : {}),
        },
      },
    },
  },
});

export const offerCopyJsonSchema = (input: OfferCopyInput) => ({
  type: "object",
  additionalProperties: false,
  required: ["slides", "captions", "hookOptions"],
  properties: {
    slides: {
      type: "array",
      minItems: input.slideCount,
      maxItems: input.slideCount,
      items: slideJsonSchema(input.offer.facts.map((fact) => fact.key)),
    },
    captions: {
      type: "object",
      additionalProperties: false,
      required: [...input.channels],
      properties: Object.fromEntries(
        OFFER_COPY_CHANNELS.filter((channel) => input.channels.includes(channel)).map((channel) => [
          channel,
          { type: "string", maxLength: COPY_CAPTION_MAX_CHARS },
        ]),
      ),
    },
    // Alternative slide 1 hooks; the server checks each like the draft and may pick one (Jev).
    hookOptions: {
      type: "array",
      maxItems: MAX_HOOK_OPTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "captionFirstLine"],
        properties: {
          headline: { type: "string", maxLength: 60 },
          captionFirstLine: { type: "string", maxLength: 200 },
        },
      },
    },
  },
});

export const createLlamaServerCopywriter = (options: LlamaServerCopywriterOptions): Copywriter => {
  const target = chatTarget(options, localBaseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async draft(input, correction) {
      const response = await doFetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify({
          model: target.model,
          messages: buildOfferCopyMessages(input, correction),
          temperature: options.temperature ?? 0.4,
          max_tokens: MAX_TOKENS,
          response_format: {
            type: "json_schema",
            json_schema: { name: "offer_copy", schema: offerCopyJsonSchema(input) },
          },
          ...target.extra,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`copywriter_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new Error("copywriter_response_invalid");
      if (choice?.finish_reason === "length") throw new Error("copywriter_truncated");
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new Error("copywriter_response_invalid");
      }
    },
  };
};

export type { OfferCopyDraft };
