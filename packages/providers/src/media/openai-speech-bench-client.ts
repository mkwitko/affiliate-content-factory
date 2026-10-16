import { localOrigin } from "./sdcpp-scene-generator.js";

/**
 * Bench-only client for OpenAI-compatible `/v1/audio/speech` servers (Kokoro-FastAPI, and
 * VoiceStudio, which is AGPL-3.0 and only ever called over HTTP as an external service).
 * Not a production SpeechSynthesizer: no word timestamps, loopback/private hosts only.
 */
export type OpenAiSpeechBenchOptions = Readonly<{
  baseUrl: string;
  timeoutMs: number;
  maxBytes: number;
  fetch?: typeof fetch;
}>;

export type OpenAiSpeechBenchClient = Readonly<{
  synthesize(input: {
    model: string;
    voice: string;
    text: string;
    seed?: number;
    /** Extra engine-specific body fields; never overrides model/voice/input/response_format. */
    extra?: Readonly<Record<string, unknown>>;
  }): Promise<{ bytes: Uint8Array; mimeType: string }>;
}>;

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const readBounded = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("speech_audio_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("speech_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
};

const isWav = (b: Uint8Array): boolean =>
  b.length >= 44 &&
  Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" &&
  Buffer.from(b.subarray(8, 12)).toString("latin1") === "WAVE";

export const createOpenAiSpeechBenchClient = (
  options: OpenAiSpeechBenchOptions,
): OpenAiSpeechBenchClient => {
  let origin: string;
  try {
    origin = localOrigin(options.baseUrl);
  } catch {
    throw new Error("speech_url_not_local");
  }
  const doFetch = options.fetch ?? fetch;
  return {
    async synthesize({ model, voice, text, seed, extra }) {
      const signal = AbortSignal.timeout(options.timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${origin}/v1/audio/speech`, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...extra,
            model,
            voice,
            input: text,
            response_format: "wav",
            ...(seed === undefined ? {} : { seed }),
          }),
          signal,
        });
      } catch (error) {
        throw new Error(isTimeout(error) ? "speech_timeout" : "speech_unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`speech_http_${response.status}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response, options.maxBytes);
      } catch (error) {
        throw isTimeout(error) ? new Error("speech_timeout") : error;
      }
      if (!isWav(bytes)) throw new Error("speech_audio_invalid");
      return { bytes, mimeType: "audio/wav" };
    },
  };
};
