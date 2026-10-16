import type { FidelityVlmImage } from "./llama-server-fidelity-vlm.js";
import { localBaseUrl } from "./llama-server-frame-reviewer.js";

/**
 * One prompt plus images to a local llama-server with --mmproj, constrained by a JSON schema.
 * Returns the decoded JSON (or the raw text); callers validate it. Loopback only.
 */
const dataUrl = (image: FidelityVlmImage) =>
  `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

export const createLlamaServerVisionJson = (options: {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}) => {
  const origin = localBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async ask(input: {
      prompt: string;
      images: readonly FidelityVlmImage[];
      schemaName: string;
      schema: unknown;
      maxTokens?: number;
    }): Promise<unknown> {
      const response = await doFetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                ...input.images.map((image) => ({
                  type: "image_url",
                  image_url: { url: dataUrl(image) },
                })),
              ],
            },
          ],
          temperature: 0,
          max_tokens: input.maxTokens ?? 200,
          response_format: {
            type: "json_schema",
            json_schema: { name: input.schemaName, schema: input.schema },
          },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`vision_json_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("vision_json_response_invalid");
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    },
  };
};
