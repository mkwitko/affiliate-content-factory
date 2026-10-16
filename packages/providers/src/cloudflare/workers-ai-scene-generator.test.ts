import { describe, expect, it, vi } from "vitest";
import { createWorkersAiSceneGenerator, sniffImageMimeType } from "./workers-ai-scene-generator.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2]);

describe("Workers AI scene generator", () => {
  it("uses the gateway, sends no seed and decodes a base64 PNG", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ result: { image: PNG.toString("base64") } }), {
        status: 200,
      });
    };
    const generator = createWorkersAiSceneGenerator({
      accountId: "acc",
      apiToken: "token",
      gateway: "money-maker",
      fetch: fetchMock,
    });
    const result = await generator.generate("empty table");
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc/money-maker/workers-ai/@cf/black-forest-labs/flux-1-schnell",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      prompt: "empty table",
      steps: 4,
    });
    expect([...result.bytes]).toEqual([...PNG]);
    expect(result).toMatchObject({
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      neurons: 173,
    });
  });
  it("supports raw PNG responses and reports provider status", async () => {
    const raw = createWorkersAiSceneGenerator({
      accountId: "a",
      apiToken: "t",
      gateway: "g",
      fetch: vi.fn(
        async () => new Response(new Uint8Array(PNG), { headers: { "content-type": "image/png" } }),
      ),
    });
    expect((await raw.generate("x")).bytes).toEqual(new Uint8Array(PNG));
    const failed = createWorkersAiSceneGenerator({
      accountId: "a",
      apiToken: "t",
      gateway: "g",
      fetch: vi.fn(async () => new Response("no", { status: 429 })),
    });
    await expect(failed.generate("x")).rejects.toThrow("scene_provider_error:429");
  });

  it("labels JPEG bytes as JPEG even when the provider says PNG (regression, slice 13)", async () => {
    const generator = createWorkersAiSceneGenerator({
      accountId: "a",
      apiToken: "t",
      gateway: "g",
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { image: JPEG.toString("base64") } }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    expect((await generator.generate("x")).mimeType).toBe("image/jpeg");
    expect(sniffImageMimeType(new Uint8Array(PNG))).toBe("image/png");
    expect(() => sniffImageMimeType(new Uint8Array([1, 2, 3, 4]))).toThrow(
      "scene_provider_image_unrecognized",
    );
  });
});
