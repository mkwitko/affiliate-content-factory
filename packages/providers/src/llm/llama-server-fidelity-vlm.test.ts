import { productVisualSpecFor } from "@money-maker/core/creatives/in-scene-fidelity";
import { describe, expect, it } from "vitest";
import { createLlamaServerFidelityVlm } from "./llama-server-fidelity-vlm.js";

const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
const spec = productVisualSpecFor("Estante 3 Prateleiras");

describe("createLlamaServerFidelityVlm", () => {
  it("sends the prompt, reference and scene images in order and returns parsed JSON", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      // The compare copies the reference count (3); placement, then the scene-only count (4).
      const content =
        calls.length === 1
          ? '{"a":1,"counts":{"shelves":3}}'
          : calls.length === 2
            ? '{"restingOn":"counter_or_table","note":"on a table"}'
            : '{"shelves":4}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    const vlm = createLlamaServerFidelityVlm({
      baseUrl: "http://127.0.0.1:18081",
      model: "m",
      fetch: fetchImpl,
    });
    expect(await vlm.compare({ reference: image, scene: image, spec })).toEqual({
      a: 1,
      counts: { shelves: 4 },
      placement: { restingOn: "counter_or_table", note: "on a table" },
    });
    const parts = (index: number) =>
      (calls[index] as { messages: { content: { type: string; text?: string }[] }[] }).messages[0]
        ?.content;
    expect(parts(0)?.map((part) => part.type)).toEqual(["text", "image_url", "image_url"]);
    expect(parts(1)?.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts(1)?.[0]?.text).toContain("What is the product itself resting on");
    expect(parts(2)?.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts(2)?.[0]?.text).toContain("bottom board included");
  });
  it("asks the reference question on the photo alone", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      const content = '{"cleanProduct":false,"extras":["inset_photos"],"note":"collage"}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    const vlm = createLlamaServerFidelityVlm({
      baseUrl: "http://127.0.0.1:18081",
      model: "m",
      fetch: fetchImpl,
    });
    expect(await vlm.reference({ photo: image, offerTitle: "Estante 3 Prateleiras" })).toEqual({
      cleanProduct: false,
      extras: ["inset_photos"],
      note: "collage",
    });
    const content = (calls[0] as { messages: { content: { type: string; text?: string }[] }[] })
      .messages[0]?.content;
    expect(content?.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(content?.[0]?.text).toContain("clean product photo");
  });

  it("returns raw text when the reply is not JSON, refuses non-loopback and HTTP errors", async () => {
    const text: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "nope" } }] }));
    const vlm = createLlamaServerFidelityVlm({
      baseUrl: "http://localhost:1",
      model: "m",
      fetch: text,
    });
    expect(await vlm.compare({ reference: image, scene: image, spec })).toBe("nope");
    let calls = 0;
    const countFails = createLlamaServerFidelityVlm({
      baseUrl: "http://127.0.0.1:18081",
      model: "m",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response(
              JSON.stringify({ choices: [{ message: { content: '{"counts":{"shelves":3}}' } }] }),
            )
          : new Response("x", { status: 500 });
      },
    });
    expect(await countFails.compare({ reference: image, scene: image, spec })).toEqual({
      counts: { shelves: 3 },
    });
    expect(() =>
      createLlamaServerFidelityVlm({ baseUrl: "http://example.com", model: "m" }),
    ).toThrow();
    const bad = createLlamaServerFidelityVlm({
      baseUrl: "http://127.0.0.1:1",
      model: "m",
      fetch: async () => new Response("x", { status: 500 }),
    });
    await expect(bad.compare({ reference: image, scene: image, spec })).rejects.toThrow(
      "fidelity_vlm_http_500",
    );
  });
});
