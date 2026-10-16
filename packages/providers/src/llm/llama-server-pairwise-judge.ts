import {
  pairwiseJudgeJsonSchema,
  pairwiseJudgePrompt,
} from "@money-maker/core/arena/pairwise-judge";
import type { FidelityVlmImage } from "./llama-server-fidelity-vlm.js";
import { localBaseUrl } from "./llama-server-frame-reviewer.js";

/**
 * Arena pairwise judge on a local llama-server started with --mmproj. Sends references, then
 * candidate A, then candidate B. Returns the decoded JSON (or raw text); validation stays in core
 * (`parsePairwiseJudgeAnswer`). Loopback only.
 */
const dataUrl = (image: FidelityVlmImage) =>
  `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

export const createLlamaServerPairwiseJudge = (options: {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}) => {
  const origin = localBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async judge(input: {
      brief: string;
      references: readonly Readonly<{ kind: "product" | "character"; image: FidelityVlmImage }>[];
      a: FidelityVlmImage;
      b: FidelityVlmImage;
    }): Promise<unknown> {
      const prompt = pairwiseJudgePrompt({
        brief: input.brief,
        references: input.references.map((r) => r.kind),
      });
      const images = [...input.references.map((r) => r.image), input.a, input.b];
      const response = await doFetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...images.map((image) => ({
                  type: "image_url",
                  image_url: { url: dataUrl(image) },
                })),
              ],
            },
          ],
          temperature: 0,
          max_tokens: 300,
          response_format: {
            type: "json_schema",
            json_schema: { name: "pairwise_judge", schema: pairwiseJudgeJsonSchema },
          },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`pairwise_judge_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("pairwise_judge_response_invalid");
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    },
  };
};
