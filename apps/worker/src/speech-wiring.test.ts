import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildSpeechSynthesizer } from "./speech-wiring.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const line = { text: "oi", voiceId: "pf_dora", language: "pt-BR", workspaceId };

const fakes = () => ({
  assetRepository: {
    listByMetadata: vi.fn(async () => []),
    create: vi.fn(),
    updateState: vi.fn(),
    updateMetadata: vi.fn(),
  },
  assetStore: { putObject: vi.fn(), createDownload: vi.fn() },
  // Kokoro answers 500, so every synthesize reaching it fails fast.
  fetch: vi.fn(async () => new Response("", { status: 500 })),
});

describe("buildSpeechSynthesizer", () => {
  it("skips the stage cache when STAGE_CACHE=off", async () => {
    const f = fakes();
    const synthesizer = buildSpeechSynthesizer({
      ttsUrl: "http://localhost:8880",
      assetStore: f.assetStore as never,
      assetRepository: f.assetRepository as never,
      env: { STAGE_CACHE: "off" },
      fetch: f.fetch as never,
    });
    await expect(synthesizer.synthesize(line)).rejects.toThrow(/voice_synthesis_failed/);
    expect(f.assetRepository.listByMetadata).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("consults the stage cache when enabled", async () => {
    const f = fakes();
    const synthesizer = buildSpeechSynthesizer({
      ttsUrl: "http://localhost:8880",
      assetStore: f.assetStore as never,
      assetRepository: f.assetRepository as never,
      env: {},
      fetch: f.fetch as never,
    });
    await expect(synthesizer.synthesize(line)).rejects.toThrow(/voice_synthesis_failed/);
    expect(f.assetRepository.listByMetadata).toHaveBeenCalledOnce();
    expect(f.assetRepository.create).not.toHaveBeenCalled();
  });

  it("works without an asset store, uncached", async () => {
    const f = fakes();
    const synthesizer = buildSpeechSynthesizer({
      ttsUrl: "http://localhost:8880",
      assetRepository: f.assetRepository as never,
      env: {},
      fetch: f.fetch as never,
    });
    await expect(synthesizer.synthesize(line)).rejects.toThrow(/voice_synthesis_failed/);
    expect(f.assetRepository.listByMetadata).not.toHaveBeenCalled();
  });
});
