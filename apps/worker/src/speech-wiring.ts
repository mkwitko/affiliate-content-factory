import type { AssetStore } from "@money-maker/core/assets/asset-store";
import { createCachedSpeechSynthesizer } from "@money-maker/core/assets/cached-speech-synthesizer";
import type { SpeechSynthesizer } from "@money-maker/core/assets/speech-synthesizer";
import { createSpokenTextSynthesizer } from "@money-maker/core/assets/spoken-text";
import {
  createStageCache,
  type StageCacheDependencies,
} from "@money-maker/core/assets/stage-cache";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";

/** Largest stored clip the cache downloads; a 60 s WAV at 24 kHz mono is about 3 MB. */
const maxCachedClipBytes = 50_000_000;

/**
 * spokenForm(cached(kokoro)): the stage-cache key is the spoken-form text Kokoro receives, and
 * the wrapper outside collapses raw words back to display text on a hit as on a miss.
 * STAGE_CACHE=off or a missing asset store synthesizes every line (spec 2026-09-30 stage cache).
 */
export const buildSpeechSynthesizer = (input: {
  ttsUrl: string;
  assetStore?: AssetStore | undefined;
  assetRepository: StageCacheDependencies["assets"];
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}): SpeechSynthesizer => {
  const kokoro = createKokoroSpeechSynthesizer({
    baseUrl: input.ttsUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!input.assetStore || input.env["STAGE_CACHE"] === "off")
    return createSpokenTextSynthesizer(kokoro);
  const cache = createStageCache({
    assets: input.assetRepository,
    store: input.assetStore,
    fetchBytes: async (url) =>
      (
        await fetchSafeMedia(new URL(url), {
          allowedMimeTypes: ["audio/wav"],
          maxBytes: maxCachedClipBytes,
        })
      ).bytes,
    log: (event) => console.info("stage_cache", event),
  });
  return createSpokenTextSynthesizer(
    createCachedSpeechSynthesizer({
      inner: kokoro,
      cache,
      version: input.env["TTS_MODEL_VERSION"] || "kokoro-v1",
    }),
  );
};
