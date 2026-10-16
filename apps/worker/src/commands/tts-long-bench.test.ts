import { readFile } from "node:fs/promises";
import { createSpokenTextSynthesizer } from "@money-maker/core/assets/spoken-text";
import { expandSpokenEn } from "@money-maker/core/assets/spoken-text-en";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";
import { describe, expect, it } from "vitest";
import { checkNarration, FIXTURE_PATH, runNarrationCheck } from "./tts-long-bench.js";

const BYTE_RATE = 48_000; // 24 kHz mono 16-bit
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
// Streaming header like Kokoro's: sizes 0xFFFFFFFF, so duration comes from the bytes present.
const header = (): number[] => [
  ...ascii("RIFF"),
  ...u32(0xffffffff),
  ...ascii("WAVE"),
  ...ascii("fmt "),
  ...u32(16),
  1,
  0,
  1,
  0,
  ...u32(24000),
  ...u32(BYTE_RATE),
  2,
  0,
  16,
  0,
  ...ascii("data"),
  ...u32(0xffffffff),
];

/** Splits at sentence ends into chunks of at most `max` characters, like the sidecar does. */
const sentenceChunks = (spoken: string, max = 300): string[][] => {
  const chunks: string[][] = [[]];
  let size = 0;
  for (const word of spoken.split(/\s+/u)) {
    const current = chunks[chunks.length - 1] as string[];
    current.push(word);
    size += word.length + 1;
    if (/[.?!]$/u.test(word) && size >= max) {
      chunks.push([]);
      size = 0;
    }
  }
  return chunks.filter((c) => c.length > 0);
};

/** A fake Kokoro sidecar: NDJSON chunks, absolute timestamps, header on the first chunk only. */
const fakeSidecar = (chunkLog: string[][]): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string };
    let clock = 0; // seconds
    const lines = sentenceChunks(input).map((chunk, index) => {
      chunkLog.push(chunk);
      const timestamps = chunk.map((word) => {
        const start = clock;
        clock += 0.08 + word.length * 0.065;
        return { word, start_time: start, end_time: clock };
      });
      clock += 0.12; // pause between chunks
      const seconds = clock - (timestamps[0]?.start_time ?? 0);
      const pcm = new Uint8Array(Math.round(seconds * BYTE_RATE) & ~1);
      const audio = index === 0 ? new Uint8Array([...header(), ...pcm]) : pcm;
      return JSON.stringify({ audio: Buffer.from(audio).toString("base64"), timestamps });
    });
    return new Response(lines.join("\n"), { status: 200 });
  }) as typeof fetch;

describe("10-minute en-US narration (fake sidecar)", () => {
  it("keeps every word, in order, with clean chunk boundaries and a sensible duration", async () => {
    const text = (await readFile(FIXTURE_PATH, "utf8")).trim().replace(/\s+/gu, " ");
    expect(text.split(" ").length).toBeGreaterThanOrEqual(1450);
    const chunkLog: string[][] = [];
    const synthesizer = createSpokenTextSynthesizer(
      createKokoroSpeechSynthesizer({
        baseUrl: "http://127.0.0.1:18880",
        fetch: fakeSidecar(chunkLog),
      }),
    );

    const { report } = await runNarrationCheck({ synthesizer, text, voiceId: "af_heart" });

    expect(report.problems).toEqual([]);
    expect(report.captionWords).toBe(report.writtenWords);
    expect(report.durationMs).toBeGreaterThan(8 * 60_000);
    expect(report.durationMs).toBeLessThan(12 * 60_000);

    // The sidecar saw the spoken form, split at sentence ends, and no word was lost or repeated.
    expect(chunkLog.length).toBeGreaterThan(10);
    expect(chunkLog.flat().join(" ")).toBe(expandSpokenEn(text).spoken);
    for (const chunk of chunkLog) expect(chunk.at(-1)).toMatch(/[.?!]$/u);
  });

  it("flags a dropped word, an overlap and a wrong pace", () => {
    const written = "one two three four";
    const words = [
      { text: "one", startMs: 0, endMs: 300 },
      { text: "two", startMs: 250, endMs: 600 },
      { text: "three", startMs: 600, endMs: 900 },
    ];
    const { problems } = checkNarration(written, { words, durationMs: 900 });
    expect(problems).toEqual(
      expect.arrayContaining([
        "word_count:3!=4",
        "word_overlap:1",
        expect.stringMatching(/^pace_wpm/u),
      ]),
    );
  });
});
