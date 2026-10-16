import { describe, expect, it, vi } from "vitest";
import {
  createKokoroSpeechSynthesizer,
  kokoroLanguageCode,
  parseCaptionedSpeechResponse,
} from "./kokoro-speech-synthesizer.js";

const u32le = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

// 24 kHz mono 16-bit PCM: byteRate = 24000 * 2 = 48000 bytes/sec.
const byteRate = 24000 * 2;

/** Minimal 44-byte PCM WAV header (no LIST chunk) followed by `dataSize` bytes of `fill`. */
const wavBytes = (dataSize: number, fill = 0): Uint8Array =>
  new Uint8Array([
    ...ascii("RIFF"),
    ...u32le(36 + dataSize),
    ...ascii("WAVE"),
    ...ascii("fmt "),
    ...u32le(16),
    ...u16le(1),
    ...u16le(1),
    ...u32le(24000),
    ...u32le(byteRate),
    ...u16le(2),
    ...u16le(16),
    ...ascii("data"),
    ...u32le(dataSize),
    ...new Array(dataSize).fill(fill),
  ]);

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const jsonResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("kokoroLanguageCode", () => {
  it("maps pt-BR to p and en-US to a", () => {
    expect(kokoroLanguageCode("pt-BR")).toBe("p");
    expect(kokoroLanguageCode("pt")).toBe("p");
    expect(kokoroLanguageCode("en-US")).toBe("a");
    expect(kokoroLanguageCode("en")).toBe("a");
  });

  it("throws voice_language_unsupported for an unmapped language", () => {
    expect(() => kokoroLanguageCode("ja")).toThrow("voice_language_unsupported");
  });
});

describe("parseCaptionedSpeechResponse", () => {
  it("concatenates NDJSON audio chunks in order and collects all words", () => {
    const chunk1Audio = wavBytes(100, 1);
    const chunk2Audio = new Uint8Array(50).fill(2); // raw PCM continuation, no header
    const body = [
      JSON.stringify({
        audio: toBase64(chunk1Audio),
        timestamps: [{ word: "Esse", start_time: 0.06675, end_time: 0.29175 }],
      }),
      JSON.stringify({
        audio: toBase64(chunk2Audio),
        timestamps: [{ word: "pia.", start_time: 0.3, end_time: 0.6 }],
      }),
    ].join("\n");

    const { bytes, words } = parseCaptionedSpeechResponse(body);

    expect(bytes.length).toBe(chunk1Audio.length + chunk2Audio.length);
    expect(bytes.subarray(0, chunk1Audio.length)).toEqual(chunk1Audio);
    expect(bytes.subarray(chunk1Audio.length)).toEqual(chunk2Audio);
    expect(words).toEqual([
      { text: "Esse", startMs: 67, endMs: 292 },
      { text: "pia.", startMs: 300, endMs: 600 },
    ]);
  });

  it("returns an empty words array without throwing when timestamps are absent", () => {
    const body = JSON.stringify({ audio: toBase64(wavBytes(10)), timestamps: [] });
    const { words } = parseCaptionedSpeechResponse(body);
    expect(words).toEqual([]);
  });
});

describe("createKokoroSpeechSynthesizer", () => {
  it("posts to /dev/captioned_speech with the pt-BR lang code and parses the response", async () => {
    const audio = wavBytes(4800);
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        JSON.stringify({
          audio: toBase64(audio),
          timestamps: [{ word: "Olá", start_time: 0.0, end_time: 0.3 }],
        }),
      ),
    );
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    const output = await synthesizer.synthesize({
      text: "Olá mundo",
      voiceId: "pf_dora",
      language: "pt-BR",
    });

    expect(output.bytes.length).toBe(4844);
    expect(output.mimeType).toBe("audio/wav");
    expect(output.durationMs).toBe(100);
    expect(output.words).toEqual([{ text: "Olá", startMs: 0, endMs: 300 }]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8880/dev/captioned_speech");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      model: "kokoro",
      input: "Olá mundo",
      voice: "pf_dora",
      response_format: "wav",
      lang_code: "p",
      return_timestamps: true,
    });
  });

  it("rejects with voice_synthesis_failed:<status> on an HTTP error, without leaking the input text", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    const secretText = "this is the private script text";
    await expect(
      synthesizer.synthesize({ text: secretText, voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:500");
    await expect(
      synthesizer.synthesize({ text: secretText, voiceId: "v1", language: "en-US" }),
    ).rejects.not.toThrow(new RegExp(secretText));
  });

  it("rejects with voice_synthesis_failed:timeout when fetch aborts", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:timeout");
  });

  it("also maps a DOMException-shaped abort to voice_synthesis_failed:timeout", async () => {
    // Node's undici fetch throws a DOMException (not an Error subclass) on abort.
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:timeout");
  });

  it("throws voice_language_unsupported before calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unreachable"));
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "ja" }),
    ).rejects.toThrow("voice_language_unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects with voice_synthesis_failed:timeout when the body stalls after headers arrive", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      init?.signal?.addEventListener("abort", () => {
        streamController.error(new DOMException("The operation was aborted.", "AbortError"));
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    });
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
      timeoutMs: 30,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:timeout");
  });

  it("rejects with voice_synthesis_failed:parse without leaking the response body", async () => {
    const responseBody = "not json at all -- private script leak check";
    const fetcher = vi.fn<typeof fetch>(async () => new Response(responseBody, { status: 200 }));
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:parse");
    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.not.toThrow(/private script leak check/);
  });

  it("rejects with voice_synthesis_failed:wav_invalid when the audio isn't a valid WAV", async () => {
    const notWav = new TextEncoder().encode("not a wav file at all");
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(JSON.stringify({ audio: toBase64(notWav), timestamps: [] })),
    );
    const synthesizer = createKokoroSpeechSynthesizer({
      baseUrl: "http://127.0.0.1:8880",
      fetch: fetcher,
    });

    await expect(
      synthesizer.synthesize({ text: "hi", voiceId: "v1", language: "en-US" }),
    ).rejects.toThrow("voice_synthesis_failed:wav_invalid");
  });
});
