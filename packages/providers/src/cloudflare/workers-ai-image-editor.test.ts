import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createWorkersAiImageEditor, kleinNeurons } from "./workers-ai-image-editor.js";

const png = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#ccc" } })
      .png()
      .toBuffer(),
  );

describe("Workers AI Klein editor", () => {
  it("sends shrunk references, the size and the seed as multipart, and reads the image", async () => {
    const sent: FormData[] = [];
    const out = await png(768, 1024);
    const editor = createWorkersAiImageEditor({
      accountId: "acct",
      apiToken: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe(
          "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/black-forest-labs/flux-2-klein-4b",
        );
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
        sent.push(init.body as FormData);
        return new Response(
          JSON.stringify({ result: { image: Buffer.from(out).toString("base64") } }),
        );
      }) as unknown as typeof fetch,
    });
    const image = await editor.edit(
      "product on a table",
      [await png(1200, 900)],
      { width: 768, height: 1024 },
      { seed: 42 },
    );
    const form = sent[0] as FormData;
    expect(form.get("seed")).toBe("42");
    expect(form.get("width")).toBe("768");
    const reference = form.get("input_image_0") as Blob;
    const meta = await sharp(new Uint8Array(await reference.arrayBuffer())).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThan(512);
    expect(image).toMatchObject({
      width: 768,
      height: 1024,
      seed: 42,
      model: "workers-ai:flux-2-klein-4b",
    });
  });

  it("reports a 429 as an exhausted quota", async () => {
    const editor = createWorkersAiImageEditor({
      accountId: "a",
      apiToken: "t",
      fetch: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(editor.edit("p", await png(10, 10))).rejects.toThrow("quota_exhausted:workers_ai");
  });

  it("prices neurons from output tiles and references", () => {
    expect(kleinNeurons({ width: 1024, height: 1024 }, 1)).toBe(Math.ceil(4 * 26.05 + 5.37));
  });
});
