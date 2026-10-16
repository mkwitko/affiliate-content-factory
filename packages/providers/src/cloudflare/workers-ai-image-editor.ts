import type { GeneratedSceneImage, ImageEditor } from "@money-maker/core/creatives/scene-bank";
import sharp from "sharp";
import { sniffImageMimeType } from "./workers-ai-scene-generator.js";

/**
 * FLUX.2 [klein] 4B on Workers AI (spec 2026-10-14): the desktop's scene model as a cloud route,
 * inside the account's free daily neurons. Multipart input; references must be under 512x512, so
 * each one is shrunk to fit 511 px before upload. Terms: BFL claims no rights in outputs
 * (bfl.ai/legal/terms-of-service, read 2026-10-14); the owner approved hosted models on
 * 2026-10-14.
 */
export const WORKERS_AI_KLEIN_MODEL = "workers-ai:flux-2-klein-4b";
const ENDPOINT_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_REFERENCE_SIDE = 511;
/** Workers AI pricing for this model (2026-10-14): neurons per 512x512 tile. */
const OUTPUT_NEURONS_PER_TILE = 26.05;
const INPUT_NEURONS_PER_TILE = 5.37;

export const kleinNeurons = (
  output: Readonly<{ width: number; height: number }>,
  references: number,
): number => {
  const tiles = Math.ceil(output.width / 512) * Math.ceil(output.height / 512);
  return Math.ceil(tiles * OUTPUT_NEURONS_PER_TILE + references * INPUT_NEURONS_PER_TILE);
};

const fitReference = async (bytes: Uint8Array): Promise<Blob> =>
  new Blob(
    [
      new Uint8Array(
        await sharp(bytes)
          .rotate()
          .resize(MAX_REFERENCE_SIDE, MAX_REFERENCE_SIDE, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer(),
      ),
    ],
    { type: "image/png" },
  );

export const createWorkersAiImageEditor = (configuration: {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ImageEditor => {
  const request = configuration.fetch ?? fetch;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}/ai/run/${ENDPOINT_MODEL}`;
  return {
    async edit(prompt, referenceImage, size, options): Promise<GeneratedSceneImage> {
      const references = (
        referenceImage instanceof Uint8Array ? [referenceImage] : [...referenceImage]
      ).slice(0, 4);
      const output = { width: size?.width ?? 1024, height: size?.height ?? 1024 };
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("width", String(output.width));
      form.append("height", String(output.height));
      if (options?.seed !== undefined) form.append("seed", String(options.seed));
      for (const [index, reference] of references.entries())
        form.append(
          `input_image_${index}`,
          await fitReference(reference),
          `reference-${index}.png`,
        );
      const response = await request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${configuration.apiToken}` },
        body: form,
        signal: AbortSignal.timeout(configuration.timeoutMs ?? 180_000),
      });
      // The daily free neurons ran out (or the account is rate limited): the route pauses.
      if (response.status === 429) throw new Error("quota_exhausted:workers_ai");
      if (!response.ok) throw new Error(`scene_provider_error:${response.status}`);
      const payload = (await response.json()) as { result?: { image?: unknown } };
      const image = payload.result?.image;
      if (typeof image !== "string" || image.length === 0)
        throw new Error("scene_provider_response_invalid");
      const bytes = new Uint8Array(Buffer.from(image, "base64"));
      const meta = await sharp(bytes).metadata();
      return {
        bytes,
        mimeType: sniffImageMimeType(bytes),
        width: meta.width ?? output.width,
        height: meta.height ?? output.height,
        neurons: kleinNeurons(output, references.length),
        model: WORKERS_AI_KLEIN_MODEL,
        ...(options?.seed !== undefined ? { seed: options.seed } : {}),
        provenance: { runtime: "workers-ai", observedModel: ENDPOINT_MODEL },
      };
    },
  };
};
