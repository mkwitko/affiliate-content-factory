import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCachedSpeechSynthesizer, TTS_STAGE } from "./cached-speech-synthesizer.js";
import type { SpeechSynthesizer } from "./speech-synthesizer.js";
import type { StageCache, StageCacheRequest } from "./stage-cache.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const bytes = new Uint8Array([1, 2, 3]);
const words = [{ text: "oi", startMs: 0, endMs: 900 }];

const inner = (): SpeechSynthesizer => ({
  synthesize: vi.fn(async () => ({
    bytes,
    mimeType: "audio/wav" as const,
    durationMs: 900,
    words,
  })),
});

/** A cache fake that records the request and replays a scripted result. */
const cacheFake = (hit: boolean) => {
  const requests: StageCacheRequest[] = [];
  const cache: StageCache = {
    async getOrProduce(request) {
      requests.push(request);
      if (hit)
        return {
          hit: true,
          assetId: "cached-1",
          bytes,
          mimeType: "audio/wav",
          metadata: { durationMs: 900, words },
        };
      const produced = await request.produce();
      return { hit: false, assetId: "new-1", ...produced };
    },
  };
  return { cache, requests };
};

describe("createCachedSpeechSynthesizer", () => {
  it("keys the tts stage on text, voice and language with the given version", async () => {
    const { cache, requests } = cacheFake(false);
    const synthesizer = createCachedSpeechSynthesizer({
      inner: inner(),
      cache,
      version: "kokoro-v1",
    });
    const result = await synthesizer.synthesize({
      text: "oi",
      voiceId: "pf_dora",
      language: "pt-BR",
      workspaceId,
    });
    expect(requests[0]).toMatchObject({
      workspaceId,
      stage: TTS_STAGE,
      version: "kokoro-v1",
      inputs: { text: "oi", voiceId: "pf_dora", language: "pt-BR" },
    });
    expect(result.cached).toBe(false);
    expect(result.durationMs).toBe(900);
  });

  it("stores durationMs and words as producer metadata on a miss", async () => {
    const { cache, requests } = cacheFake(false);
    await createCachedSpeechSynthesizer({ inner: inner(), cache, version: "v" }).synthesize({
      text: "oi",
      voiceId: "pf_dora",
      language: "pt-BR",
      workspaceId,
    });
    const produced = await requests[0]!.produce();
    expect(produced).toEqual({
      bytes,
      mimeType: "audio/wav",
      metadata: { durationMs: 900, words },
    });
  });

  it("returns the stored clip on a hit without calling the inner synthesizer", async () => {
    const { cache } = cacheFake(true);
    const kokoro = inner();
    const result = await createCachedSpeechSynthesizer({
      inner: kokoro,
      cache,
      version: "v",
    }).synthesize({
      text: "oi",
      voiceId: "pf_dora",
      language: "pt-BR",
      workspaceId,
    });
    expect(kokoro.synthesize).not.toHaveBeenCalled();
    expect(result).toEqual({ bytes, mimeType: "audio/wav", durationMs: 900, words, cached: true });
  });

  it("bypasses the cache when the call has no workspaceId", async () => {
    const { cache, requests } = cacheFake(true);
    const kokoro = inner();
    const result = await createCachedSpeechSynthesizer({
      inner: kokoro,
      cache,
      version: "v",
    }).synthesize({
      text: "oi",
      voiceId: "pf_dora",
      language: "pt-BR",
    });
    expect(requests).toHaveLength(0);
    expect(kokoro.synthesize).toHaveBeenCalledOnce();
    expect(result.cached).toBeUndefined();
  });

  it("falls back to the inner synthesizer when a hit carries malformed metadata", async () => {
    const cache: StageCache = {
      async getOrProduce() {
        return {
          hit: true,
          assetId: "bad",
          bytes,
          mimeType: "audio/wav",
          metadata: { durationMs: "x" },
        };
      },
    };
    const kokoro = inner();
    const result = await createCachedSpeechSynthesizer({
      inner: kokoro,
      cache,
      version: "v",
    }).synthesize({
      text: "oi",
      voiceId: "pf_dora",
      language: "pt-BR",
      workspaceId,
    });
    expect(kokoro.synthesize).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
  });
});
