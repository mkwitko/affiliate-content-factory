import { describe, expect, it } from "vitest";
import { createLlamaServerPairwiseJudge } from "./llama-server-pairwise-judge.js";

const png = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

describe("llama-server pairwise judge", () => {
  it("sends references first, then A and B, with the json schema", async () => {
    type Sent = { messages: { content: { type: string }[] }[]; response_format: unknown };
    const calls: Sent[] = [];
    const judge = createLlamaServerPairwiseJudge({
      baseUrl: "http://127.0.0.1:8080",
      model: "qwen3-vl-4b",
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string) as Sent);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"overallWinner":"A"}' } }] }),
        );
      }) as typeof fetch,
    });
    const answer = await judge.judge({
      brief: "Carla na cozinha",
      references: [{ kind: "product", image: png }],
      a: png,
      b: png,
    });
    expect(answer).toEqual({ overallWinner: "A" });
    const sent = calls[0];
    const parts = sent?.messages[0]?.content.map((c) => c.type);
    expect(parts).toEqual(["text", "image_url", "image_url", "image_url"]);
    expect(sent?.response_format).toMatchObject({ type: "json_schema" });
  });

  it("refuses a non-loopback server", () => {
    expect(() =>
      createLlamaServerPairwiseJudge({ baseUrl: "http://10.0.0.2:8080", model: "m" }),
    ).toThrow("frame_reviewer_url_not_local");
  });
});
