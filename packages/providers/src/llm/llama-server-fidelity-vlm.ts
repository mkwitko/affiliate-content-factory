import {
  type ProductVisualSpec,
  vlmCountJsonSchema,
  vlmCountPrompt,
  vlmFidelityJsonSchema,
  vlmFidelityPrompt,
  vlmPlacementJsonSchema,
  vlmPlacementPrompt,
  vlmReferenceJsonSchema,
  vlmReferencePrompt,
} from "@money-maker/core/creatives/in-scene-fidelity";
import { chatTarget } from "./chat-target.js";
import { localBaseUrl } from "./llama-server-frame-reviewer.js";

/**
 * Asks a local llama-server (started with --mmproj) whether a scene shows the reference product.
 * Returns the parsed JSON (or the raw text when it is not JSON); the strict validation and the
 * verdict stay in core (`parseVlmFidelityAnswer`, `judgeInSceneFidelity`). Loopback only.
 */
export type FidelityVlmImage = Readonly<{ bytes: Uint8Array; mimeType: string }>;

const dataUrl = (image: FidelityVlmImage) =>
  `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

export const createLlamaServerFidelityVlm = (options: {
  baseUrl?: string;
  model: string;
  /** Cloud route through the Vercel AI Gateway instead of the local server. */
  gateway?: Readonly<{ apiKey: string }>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}) => {
  const target = chatTarget(options, localBaseUrl);
  const doFetch = options.fetch ?? fetch;
  const ask = async (
    prompt: string,
    images: readonly FidelityVlmImage[],
    schemaName: string,
    schema: unknown,
    maxTokens: number,
  ): Promise<unknown> => {
    const response = await doFetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image) } })),
            ],
          },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_schema", json_schema: { name: schemaName, schema } },
        ...target.extra,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!response.ok) throw new Error(`fidelity_vlm_http_${response.status}`);
    const body = (await response.json()) as {
      choices?: readonly { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("fidelity_vlm_response_invalid");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  };
  return {
    async compare(input: {
      reference: FidelityVlmImage;
      scene: FidelityVlmImage;
      spec: ProductVisualSpec;
      /** Names the product in the placement question; without it the judge may pick another object. */
      offerTitle?: string;
    }): Promise<unknown> {
      const answer = await ask(
        vlmFidelityPrompt(input.spec),
        [input.reference, input.scene],
        "in_scene_fidelity",
        vlmFidelityJsonSchema(input.spec),
        // Room for up to 8 subject boxes after the verdict fields.
        800,
      );
      if (typeof answer !== "object" || answer === null) return answer;
      // Placement on the scene alone; a failed or malformed answer is simply absent.
      const placement = await ask(
        vlmPlacementPrompt(input.offerTitle ?? ""),
        [input.scene],
        "placement",
        vlmPlacementJsonSchema(),
        80,
      ).catch(() => null);
      const withPlacement =
        typeof placement === "object" && placement !== null ? { ...answer, placement } : answer;
      if (input.spec.features.length === 0) return withPlacement;
      // Each count on the scene alone (see vlmCountPrompt); a failed count keeps the compared one.
      const counts: Record<string, unknown> = {
        ...((answer as { counts?: Record<string, unknown> }).counts ?? {}),
      };
      for (const { key } of input.spec.features) {
        const counted = await ask(
          vlmCountPrompt(key),
          [input.scene],
          `count_${key}`,
          vlmCountJsonSchema(key),
          60,
        ).catch(() => null);
        const value = (counted as Record<string, unknown> | null)?.[key];
        if (typeof value === "number" || value === null) counts[key] = value;
      }
      return { ...withPlacement, counts };
    },
    /** Reference photo check (brief 11.1): the listing photo alone; the server parses strictly. */
    reference(input: { photo: FidelityVlmImage; offerTitle: string }): Promise<unknown> {
      return ask(
        vlmReferencePrompt(input.offerTitle),
        [input.photo],
        "reference_check",
        vlmReferenceJsonSchema(),
        120,
      );
    },
  };
};
