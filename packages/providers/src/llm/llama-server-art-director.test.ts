import { describe, expect, it } from "vitest";
import { createLlamaServerArtDirector } from "./llama-server-art-director.js";

const input = {
  product: "rack",
  character: { name: "Carla", description: "35" },
  otherNames: [],
  world: "kitchen",
  slides: [{ index: 1, template: "hero" as const, headline: "Oi" }],
};
const reply = (content: unknown, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }));

describe("llama-server art director", () => {
  it("posts the schema-constrained request and returns the parsed JSON", async () => {
    let body: Record<string, unknown> = {};
    const director = createLlamaServerArtDirector({
      baseUrl: "http://127.0.0.1:18081",
      model: "local:qwen3.5-9b",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return reply('{"lines":[{"index":1,"scene":"Carla at work"}]}');
      },
    });
    expect(await director.direct(input)).toEqual({ lines: [{ index: 1, scene: "Carla at work" }] });
    expect(body.temperature).toBe(0.4);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect((body.response_format as { json_schema: { name: string } }).json_schema.name).toBe(
      "scene_lines",
    );
  });

  it("refuses non-loopback servers and maps failures to errors", async () => {
    expect(() =>
      createLlamaServerArtDirector({ baseUrl: "http://10.0.0.2:1", model: "m" }),
    ).toThrow("copywriter_url_not_local");
    const make = (response: Response) =>
      createLlamaServerArtDirector({
        baseUrl: "http://127.0.0.1:1",
        model: "m",
        fetch: async () => response,
      });
    await expect(make(new Response("", { status: 500 })).direct(input)).rejects.toThrow(
      "art_director_http_500",
    );
    await expect(make(reply("{", "stop")).direct(input)).rejects.toThrow(
      "art_director_response_invalid",
    );
    await expect(make(reply("{}", "length")).direct(input)).rejects.toThrow(
      "art_director_truncated",
    );
  });
});
