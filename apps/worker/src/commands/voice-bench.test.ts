import {
  VOICE_BENCH_CORPUS,
  VOICE_BENCH_CORPUS_PT_BR,
} from "@money-maker/core/assets/fixtures/voice-bench-corpus";
import { describe, expect, it, vi } from "vitest";
import {
  buildListeningPage,
  readVoiceBenchCandidates,
  runVoiceBench,
  summarizeVoiceBench,
  type VoiceCandidate,
} from "./voice-bench.js";

const cand = (over: Partial<VoiceCandidate> = {}): VoiceCandidate => ({
  baseUrl: "http://127.0.0.1:18880",
  engine: "kokoro",
  model: "kokoro",
  voice: "af_heart",
  policyModel: "local:kokoro",
  ...over,
});
/** 24 kHz mono 16-bit, 1 second. */
const wav = (): Uint8Array => {
  const b = Buffer.alloc(44 + 48000);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + 48000, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(48000, 40);
  return b;
};
const ok = (async () => new Response(Buffer.from(wav()))) as unknown as typeof fetch;

describe("voice bench", () => {
  it("covers the fixed corpus and sends the spoken form", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response(Buffer.from(wav())));
    const rows = await runVoiceBench([cand()], { fetch: f as never });
    expect(rows).toHaveLength(VOICE_BENCH_CORPUS.length);
    expect(rows[0]).toMatchObject({
      audioMs: 1000,
      sampleRate: 24000,
      channels: 1,
      decodeValid: true,
      error: null,
      humanScore: null,
      policyEnabled: true,
    });
    const sent = f.mock.calls.map((c) => String(JSON.parse(String(c[1].body)).input)).join(" ");
    expect(sent).toContain("nineteen ninety nine");
    expect(sent).not.toContain("$");
    const s = summarizeVoiceBench(rows);
    expect(s.promoted).toBe(false);
    expect(s.candidates[0]).toMatchObject({ failures: 0 });
  });

  it("records connection-refused per row and continues with other candidates", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes(":3900")) throw new TypeError("fetch failed");
      return new Response(Buffer.from(wav()));
    });
    const rows = await runVoiceBench(
      [cand({ baseUrl: "http://127.0.0.1:3900", engine: "x" }), cand()],
      { fetch: f as never },
    );
    expect(
      rows.filter((r) => r.engine === "x").every((r) => r.error === "speech_unavailable"),
    ).toBe(true);
    expect(rows.filter((r) => r.engine === "kokoro").every((r) => r.error === null)).toBe(true);
  });

  it("flags invalid audio and timeouts", async () => {
    const bad = await runVoiceBench([cand()], {
      fetch: (async () => new Response(new Uint8Array(100).fill(7))) as never,
    });
    expect(bad.every((r) => r.error === "speech_audio_invalid" && !r.decodeValid)).toBe(true);
    const slow = await runVoiceBench([cand()], {
      timeoutMs: 20,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
          ),
        )) as never,
    });
    expect(slow.every((r) => r.error === "speech_timeout")).toBe(true);
  });

  it("refuses non-commercial or unknown policy models without sending a request", async () => {
    const f = vi.fn();
    const rows = await runVoiceBench(
      [cand({ policyModel: "local:omnivoice" }), cand({ policyModel: "local:qwen3.5-4b" })],
      { fetch: f as never },
    );
    expect(f).not.toHaveBeenCalled();
    expect(rows.every((r) => r.error === "model_license_not_allowed")).toBe(true);
  });

  it("allows disabled commercial entries but flags them", async () => {
    const rows = await runVoiceBench(
      [
        cand({
          engine: "voicestudio",
          policyModel: "local:moss-tts-nano",
          baseUrl: "http://127.0.0.1:3900",
        }),
      ],
      { fetch: ok },
    );
    expect(rows[0]).toMatchObject({ policyEnabled: false, error: null });
  });

  it("rejects public hosts per row", async () => {
    const rows = await runVoiceBench([cand({ baseUrl: "http://example.com" })], {
      fetch: vi.fn() as never,
    });
    expect(rows[0]?.error).toBe("speech_url_not_local");
  });

  it("builds a seeded blind page with hidden labels", async () => {
    const cs = [cand(), cand({ engine: "other", model: "o" })];
    const rows = await runVoiceBench(cs, { fetch: ok });
    const a = buildListeningPage(cs, rows, 7);
    expect(a).toBe(buildListeningPage(cs, rows, 7));
    expect(a).toContain("hidden");
    expect(a).toContain('type="number" min="1" max="5"');
  });

  it("parses candidates from env", () => {
    expect(
      readVoiceBenchCandidates({ VOICE_BENCH_CANDIDATES: JSON.stringify([cand()]) }),
    ).toHaveLength(1);
    expect(() => readVoiceBenchCandidates({})).toThrow("voice_bench_candidates_missing");
    expect(() => readVoiceBenchCandidates({ VOICE_BENCH_CANDIDATES: "[{}]" })).toThrow();
  });

  it("runs the pt-BR corpus through the pt-BR spoken form", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response(Buffer.from(wav())));
    const rows = await runVoiceBench([cand({ voice: "pf_dora" })], {
      fetch: f as never,
      lang: "pt-BR",
    });
    expect(rows).toHaveLength(VOICE_BENCH_CORPUS_PT_BR.length);
    const sent = f.mock.calls.map((c) => String(JSON.parse(String(c[1].body)).input)).join(" ");
    expect(sent).toContain("reais");
    expect(sent).not.toContain("R$");
    expect(sent).toContain("link na bio");
  });

  it("merges candidate extra into the body without overriding core fields", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response(Buffer.from(wav())));
    await runVoiceBench([cand({ extra: { exaggeration: 0.5, input: "x", voice: "y" } })], {
      fetch: f as never,
    });
    const body = JSON.parse(String(f.mock.calls[0]?.[1].body));
    expect(body).toMatchObject({ exaggeration: 0.5, voice: "af_heart" });
    expect(body.input).not.toBe("x");
  });

  it("validates extra is a plain object", () => {
    const bad = (extra: unknown) =>
      readVoiceBenchCandidates({ VOICE_BENCH_CANDIDATES: JSON.stringify([{ ...cand(), extra }]) });
    expect(() => bad([1])).toThrow("voice_bench_candidates_invalid");
    expect(() => bad("x")).toThrow("voice_bench_candidates_invalid");
    expect(bad({ cfg_weight: 0.5 })[0]?.extra).toEqual({ cfg_weight: 0.5 });
  });
});
