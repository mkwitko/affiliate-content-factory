import { describe, expect, it } from "vitest";
import {
  createLlamaServerFrameReviewer,
  readFrameReviewerConfig,
} from "./llama-server-frame-reviewer.js";

const frame = { sceneIndex: 1, hook: true, png: new Uint8Array([137, 80, 78, 71]) };
const reply = (content: unknown, status = 200, finish = "stop") => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }),
      { status },
    );
  };
  return { calls, fetchImpl };
};

describe("createLlamaServerFrameReviewer", () => {
  it("sends the frame as a data URL with a JSON schema and thinking off", async () => {
    const { calls, fetchImpl } = reply('{"verdict":"ok","issues":[]}');
    const reviewer = createLlamaServerFrameReviewer({
      baseUrl: "http://127.0.0.1:18081/",
      model: "qwen3-vl-4b",
      fetch: fetchImpl,
    });
    expect(await reviewer.review(frame)).toEqual({ verdict: "ok", issues: [] });
    const body = calls[0]?.body as {
      messages: { role: string; content: unknown }[];
      response_format: { type: string };
      chat_template_kwargs: unknown;
    };
    expect(calls[0]?.url).toBe("http://127.0.0.1:18081/v1/chat/completions");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(body.messages)).toContain("data:image/png;base64,iVBORw==");
    expect(body.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  it("returns raw text for a truncated or non-JSON reply and throws on HTTP errors", async () => {
    const opts = { baseUrl: "http://localhost:1", model: "m" };
    expect(
      await createLlamaServerFrameReviewer({ ...opts, fetch: reply("not json").fetchImpl }).review(
        frame,
      ),
    ).toBe("not json");
    expect(
      await createLlamaServerFrameReviewer({
        ...opts,
        fetch: reply('{"verdict":', 200, "length").fetchImpl,
      }).review(frame),
    ).toBe('{"verdict":');
    await expect(
      createLlamaServerFrameReviewer({ ...opts, fetch: reply("x", 503).fetchImpl }).review(frame),
    ).rejects.toThrow("frame_reviewer_http_503");
  });

  it("refuses a URL that is not loopback", () => {
    for (const baseUrl of ["http://192.168.0.5:8080", "http://example.com", "not a url"])
      expect(() => createLlamaServerFrameReviewer({ baseUrl, model: "m" })).toThrow(
        "frame_reviewer_url_not_local",
      );
  });
});

describe("readFrameReviewerConfig", () => {
  it("is disabled unless FRAME_REVIEWER_URL is set", () => {
    expect(readFrameReviewerConfig({})).toBeNull();
    expect(readFrameReviewerConfig({ FRAME_REVIEWER_URL: " " })).toBeNull();
    expect(
      readFrameReviewerConfig({
        FRAME_REVIEWER_URL: "http://127.0.0.1:1",
        FRAME_REVIEWER_MODEL: "x",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:1", model: "x" });
  });
});
