import { describe, expect, it } from "vitest";
import { chatTarget } from "./chat-target.js";
import { createLlamaServerFidelityVlm } from "./llama-server-fidelity-vlm.js";
import { localBaseUrl } from "./llama-server-frame-reviewer.js";

describe("chatTarget", () => {
  it("sends gateway calls with the key, the provider model id and no llama.cpp fields", () => {
    expect(
      chatTarget(
        { model: "vercel:alibaba/qwen3-vl-instruct", gateway: { apiKey: "vck_x" } },
        localBaseUrl,
      ),
    ).toEqual({
      url: "https://ai-gateway.vercel.sh/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer vck_x" },
      model: "alibaba/qwen3-vl-instruct",
      extra: {},
    });
  });

  it("keeps local calls loopback-only and unauthenticated", () => {
    expect(
      chatTarget({ baseUrl: "http://127.0.0.1:18081", model: "local:x" }, localBaseUrl),
    ).toEqual({
      url: "http://127.0.0.1:18081/v1/chat/completions",
      headers: { "content-type": "application/json" },
      model: "local:x",
      extra: { chat_template_kwargs: { enable_thinking: false } },
    });
    expect(() => chatTarget({ baseUrl: "https://example.com", model: "x" }, localBaseUrl)).toThrow(
      "frame_reviewer_url_not_local",
    );
    expect(() => chatTarget({ model: "x" }, localBaseUrl)).toThrow();
  });

  it("drives the fidelity VLM through the gateway", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const vlm = createLlamaServerFidelityVlm({
      model: "vercel:alibaba/qwen3-vl-instruct",
      gateway: { apiKey: "vck_x" },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      }) as unknown as typeof fetch,
    });
    await vlm.reference?.({
      photo: { bytes: new Uint8Array([1]), mimeType: "image/png" },
      offerTitle: "Porta-tempero",
    });
    expect(calls[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("alibaba/qwen3-vl-instruct");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });
});
