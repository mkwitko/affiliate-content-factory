import type { SpeechSynthesisOutput, SpeechSynthesizer, SpokenWord } from "./speech-synthesizer.js";
import type { StageCache } from "./stage-cache.js";

export const TTS_STAGE = "tts";

/**
 * Reuses a stored voice clip for identical text, voice, language and model version.
 * Compose as spokenForm(cached(kokoro)): the key is then the spoken-form text the model
 * actually receives, and the wrapper outside still collapses words to display text.
 */
export const createCachedSpeechSynthesizer = (deps: {
  inner: SpeechSynthesizer;
  cache: StageCache;
  /** Model or container version; bump on a Kokoro upgrade so old clips miss. */
  version: string;
}): SpeechSynthesizer => ({
  async synthesize(input) {
    if (!input.workspaceId) return deps.inner.synthesize(input);
    const { text, voiceId, language, workspaceId } = input;
    const fresh = async () => ({
      ...(await deps.inner.synthesize({ text, voiceId, language })),
      cached: false,
    });
    let produced: SpeechSynthesisOutput | undefined;
    const result = await deps.cache.getOrProduce({
      workspaceId,
      stage: TTS_STAGE,
      version: deps.version,
      inputs: { text, voiceId, language },
      produce: async () => {
        produced = await fresh();
        return {
          bytes: produced.bytes,
          mimeType: produced.mimeType,
          metadata: { durationMs: produced.durationMs, words: produced.words },
        };
      },
    });
    if (produced) return produced;
    // A hit whose stored metadata is unreadable is ignored rather than trusted.
    return restore(result.bytes, result.metadata) ?? fresh();
  },
});

const isWord = (value: unknown): value is SpokenWord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SpokenWord).text === "string" &&
  Number.isFinite((value as SpokenWord).startMs) &&
  Number.isFinite((value as SpokenWord).endMs);

const restore = (
  bytes: Uint8Array,
  metadata: Readonly<Record<string, unknown>>,
): SpeechSynthesisOutput | null => {
  const durationMs = metadata["durationMs"];
  const words = metadata["words"];
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0)
    return null;
  if (!Array.isArray(words) || !words.every(isWord)) return null;
  return { bytes, mimeType: "audio/wav", durationMs, words, cached: true };
};
