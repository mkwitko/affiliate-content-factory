import type {
  SpeechSynthesisOutput,
  SpeechSynthesizer,
  SpokenWord,
} from "@money-maker/core/assets/speech-synthesizer";
import { wavDurationMs } from "@money-maker/core/assets/wav-duration";

/**
 * Adapts a Kokoro-FastAPI sidecar's `/dev/captioned_speech` endpoint to the core
 * `SpeechSynthesizer` port. The endpoint streams NDJSON: one line per audio chunk, each
 * carrying base64 WAV bytes and word-level timestamps in seconds. Only the first chunk's
 * audio starts with a RIFF header; later chunks are raw PCM continuation, so concatenating
 * decoded bytes in order yields one valid WAV. Timestamps are already absolute across chunks.
 */
export type KokoroSynthesizerOptions = Readonly<{
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>;

type CaptionedSpeechChunk = Readonly<{
  audio?: string;
  timestamps?: readonly Readonly<{ word: string; start_time: number; end_time: number }>[];
}>;

export const kokoroLanguageCode = (language: string): "p" | "a" => {
  if (/^pt(-|$)/i.test(language)) return "p";
  if (/^en(-|$)/i.test(language)) return "a";
  throw new Error("voice_language_unsupported");
};

/** Exported for tests: parses a single JSON object or NDJSON chunks into audio bytes and words. */
export const parseCaptionedSpeechResponse = (
  body: string,
): Readonly<{ bytes: Uint8Array; words: readonly SpokenWord[] }> => {
  const chunks = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptionedSpeechChunk);

  const parts = chunks.map((chunk) =>
    chunk.audio ? Buffer.from(chunk.audio, "base64") : Buffer.alloc(0),
  );
  const bytes = new Uint8Array(Buffer.concat(parts));
  const words = chunks.flatMap((chunk) =>
    (chunk.timestamps ?? []).map((t) => ({
      text: t.word,
      startMs: Math.round(t.start_time * 1000),
      endMs: Math.round(t.end_time * 1000),
    })),
  );
  return { bytes, words };
};

// A real fetch/body-read abort can surface as a DOMException (not an Error subclass) in Node's
// undici implementation, so check `.name` structurally rather than via `instanceof Error`.
const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

export const createKokoroSpeechSynthesizer = (
  options: KokoroSynthesizerOptions,
): SpeechSynthesizer => {
  const doFetch = options.fetch ?? fetch;
  // The VM sidecar shares its CPU with slide renders; one line can wait minutes under load.
  const timeoutMs = options.timeoutMs ?? 180_000;

  return {
    async synthesize(input): Promise<SpeechSynthesisOutput> {
      const langCode = kokoroLanguageCode(input.language);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await doFetch(new URL("/dev/captioned_speech", options.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "kokoro",
              input: input.text,
              voice: input.voiceId,
              response_format: "wav",
              lang_code: langCode,
              return_timestamps: true,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          throw new Error(
            isAbortError(error)
              ? "voice_synthesis_failed:timeout"
              : "voice_synthesis_failed:network",
          );
        }

        if (!response.ok) throw new Error(`voice_synthesis_failed:${response.status}`);

        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          throw new Error(
            isAbortError(error)
              ? "voice_synthesis_failed:timeout"
              : "voice_synthesis_failed:network",
          );
        }

        let bytes: Uint8Array;
        let words: readonly SpokenWord[];
        try {
          ({ bytes, words } = parseCaptionedSpeechResponse(body));
        } catch {
          throw new Error("voice_synthesis_failed:parse");
        }

        let durationMs: number;
        try {
          durationMs = wavDurationMs(bytes);
        } catch {
          throw new Error("voice_synthesis_failed:wav_invalid");
        }
        return { bytes, mimeType: "audio/wav", durationMs, words };
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
