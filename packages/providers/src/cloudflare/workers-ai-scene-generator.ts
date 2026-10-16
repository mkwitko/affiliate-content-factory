import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";

/**
 * Workers AI labels FLUX.1 schnell output as PNG but the bytes are JPEG (measured 2026-09-30:
 * every plate started FF D8). A wrong label makes librsvg drop the data URI silently, so the
 * mime type comes from the bytes, never from the header.
 */
export const sniffImageMimeType = (bytes: Uint8Array): "image/png" | "image/jpeg" => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  throw new Error("scene_provider_image_unrecognized");
};

export const createWorkersAiSceneGenerator = (configuration: {
  accountId: string;
  apiToken: string;
  gateway: string;
  fetch?: typeof fetch;
}): SceneGenerator => {
  const request = configuration.fetch ?? fetch;
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(configuration.accountId)}/${encodeURIComponent(configuration.gateway)}/workers-ai/@cf/black-forest-labs/flux-1-schnell`;
  return {
    async generate(prompt) {
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt, steps: 4 }),
      });
      if (!response.ok) throw new Error(`scene_provider_error:${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      const bytes = contentType.includes("image/png")
        ? new Uint8Array(await response.arrayBuffer())
        : (() => undefined)();
      if (bytes)
        return {
          bytes,
          mimeType: sniffImageMimeType(bytes),
          width: 1024,
          height: 1024,
          neurons: 173,
        };
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("result" in payload))
        throw new Error("scene_provider_response_invalid");
      const result = (payload as { result?: { image?: unknown } }).result;
      if (typeof result?.image !== "string" || result.image.length === 0)
        throw new Error("scene_provider_response_invalid");
      const decoded = new Uint8Array(Buffer.from(result.image, "base64"));
      return {
        bytes: decoded,
        mimeType: sniffImageMimeType(decoded),
        width: 1024,
        height: 1024,
        neurons: 173,
      };
    },
  };
};
