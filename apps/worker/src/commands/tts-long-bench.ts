import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  SpeechSynthesisOutput,
  SpeechSynthesizer,
} from "@money-maker/core/assets/speech-synthesizer";
import { createSpokenTextSynthesizer } from "@money-maker/core/assets/spoken-text";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";

/**
 * Opt-in 10-minute narration check (never part of CI). Sends the ~1,500-word en-US fixture through
 * the production wrapper (spoken form over the Kokoro adapter) in ONE request, so the sidecar's own
 * chunking and the NDJSON timestamp merge are exercised, then checks the result. The unit test in
 * tts-long-bench.test.ts runs the same `checkNarration` against a fake sidecar.
 */
export const FIXTURE_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../test-fixtures/narration-10min-en.txt",
);

export type NarrationReport = Readonly<{
  problems: readonly string[];
  writtenWords: number;
  captionWords: number;
  durationMs: number;
  wordsPerMinute: number;
}>;

/** Pure: compares a synthesis result with the written script. Empty `problems` means it passes. */
export const checkNarration = (
  written: string,
  output: Pick<SpeechSynthesisOutput, "words" | "durationMs">,
): NarrationReport => {
  const expected = written.split(/\s+/u).filter(Boolean);
  const { words, durationMs } = output;
  const problems: string[] = [];
  if (words.length !== expected.length)
    problems.push(`word_count:${words.length}!=${expected.length}`);
  expected.forEach((text, i) => {
    if (words[i]?.text !== text && problems.length < 20) problems.push(`word_text:${i}:${text}`);
  });
  let previousEnd = 0;
  words.forEach((word, i) => {
    if (problems.length >= 20) return;
    if (word.endMs < word.startMs) problems.push(`word_inverted:${i}`);
    if (word.startMs < previousEnd) problems.push(`word_overlap:${i}`);
    previousEnd = word.endMs;
  });
  if (previousEnd > durationMs + 100) problems.push("timestamps_past_audio_end");
  const wordsPerMinute = durationMs > 0 ? expected.length / (durationMs / 60_000) : 0;
  // Calm narration runs about 130 to 170 wpm; outside 100 to 200 something dropped or stretched.
  if (wordsPerMinute < 100 || wordsPerMinute > 200)
    problems.push(`pace_wpm:${wordsPerMinute.toFixed(0)}`);
  return {
    problems,
    writtenWords: expected.length,
    captionWords: words.length,
    durationMs,
    wordsPerMinute,
  };
};

const isLoopback = (url: URL): boolean =>
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

export const runNarrationCheck = async (input: {
  synthesizer: SpeechSynthesizer;
  text: string;
  voiceId: string;
}): Promise<Readonly<{ report: NarrationReport; wallMs: number }>> => {
  const started = Date.now();
  const output = await input.synthesizer.synthesize({
    text: input.text,
    voiceId: input.voiceId,
    language: "en-US",
  });
  return { report: checkNarration(input.text, output), wallMs: Date.now() - started };
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const base = new URL(args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:18880");
  if (!isLoopback(base)) throw new Error("tts_long_bench_loopback_only");
  const voiceId = args.find((a) => a.startsWith("--voice="))?.slice(8) ?? "af_heart";
  const text = (await readFile(FIXTURE_PATH, "utf8")).trim().replace(/\s+/gu, " ");
  const synthesizer = createSpokenTextSynthesizer(
    createKokoroSpeechSynthesizer({ baseUrl: base.href, timeoutMs: 45 * 60_000 }),
  );
  const { report, wallMs } = await runNarrationCheck({ synthesizer, text, voiceId });
  const audioSeconds = report.durationMs / 1000;
  console.info(
    JSON.stringify({
      voiceId,
      writtenWords: report.writtenWords,
      captionWords: report.captionWords,
      audioSeconds: Number(audioSeconds.toFixed(1)),
      wallSeconds: Number((wallMs / 1000).toFixed(1)),
      rtf: Number((wallMs / 1000 / audioSeconds).toFixed(2)),
      wordsPerMinute: Math.round(report.wordsPerMinute),
      problems: report.problems,
      pass: report.problems.length === 0,
    }),
  );
  if (report.problems.length > 0) process.exitCode = 1;
};

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "tts_long_bench_failed");
    process.exitCode = 1;
  });
}
