import {
  type ArtDirectionInput,
  artDirectionJsonSchema,
  buildArtDirectionMessages,
} from "@money-maker/core/creatives/scene-direction";
import { localBaseUrl } from "./llama-server-copywriter.js";

/**
 * Scene lines from the local copy model (spec 2026-10-08), loopback only. Returns the raw JSON;
 * `validateSceneLines` in core decides what is usable.
 */
export const createLlamaServerArtDirector = (
  options: Readonly<{
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    temperature?: number;
    fetch?: typeof fetch;
  }>,
) => {
  const origin = localBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async direct(input: ArtDirectionInput): Promise<unknown> {
      const response = await doFetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: buildArtDirectionMessages(input),
          temperature: options.temperature ?? 0.4,
          max_tokens: 1_500,
          response_format: {
            type: "json_schema",
            json_schema: { name: "scene_lines", schema: artDirectionJsonSchema(input) },
          },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
      });
      if (!response.ok) throw new Error(`art_director_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("art_director_truncated");
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new Error("art_director_response_invalid");
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new Error("art_director_response_invalid");
      }
    },
  };
};
