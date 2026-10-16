import { describe, expect, it, vi } from "vitest";
import { createOpenAiSpeechBenchClient } from "./openai-speech-bench-client.js";

const wav = (): Uint8Array => {
  const b = Buffer.alloc(48);
  b.write("RIFF", 0, "latin1");
  b.write("WAVE", 8, "latin1");
  return b;
};
const make = (fetchImpl: unknown, baseUrl = "http://127.0.0.1:3900") =>
  createOpenAiSpeechBenchClient({
    baseUrl,
    timeoutMs: 200,
    maxBytes: 1000,
    fetch: fetchImpl as typeof fetch,
  });
const input = { model: "m", voice: "v", text: "hi" };

describe("createOpenAiSpeechBenchClient", () => {
  it("posts wav JSON and returns the body", async () => {
    const f = vi.fn(async () => new Response(Buffer.from(wav())));
    const out = await make(f).synthesize({ ...input, seed: 1 });
    expect(out.mimeType).toBe("audio/wav");
    expect(out.bytes.length).toBe(48);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3900/v1/audio/speech");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "m",
      voice: "v",
      input: "hi",
      response_format: "wav",
      seed: 1,
    });
  });
  it("refuses public hosts", () => {
    expect(() => make(vi.fn(), "http://example.com")).toThrow("speech_url_not_local");
  });
  it("maps http errors", async () => {
    const c = make(async () => new Response("", { status: 503 }));
    await expect(c.synthesize(input)).rejects.toThrow("speech_http_503");
  });
  it("rejects non-WAV audio", async () => {
    const c = make(async () => new Response(new Uint8Array(60).fill(1)));
    await expect(c.synthesize(input)).rejects.toThrow("speech_audio_invalid");
  });
  it("bounds the body", async () => {
    const c = make(async () => new Response(new Uint8Array(2000)));
    await expect(c.synthesize(input)).rejects.toThrow("speech_too_large");
  });
  it("times out", async () => {
    const f = async (_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
        ),
      );
    await expect(make(f).synthesize(input)).rejects.toThrow("speech_timeout");
  });
});
