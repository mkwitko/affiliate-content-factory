import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { ReelRenderer } from "@money-maker/core/assets/reel-renderer";
import type { SpeechSynthesizer } from "@money-maker/core/assets/speech-synthesizer";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentVariant } from "@money-maker/core/content/content";
import { uuidFromKey } from "@money-maker/core/content/offer-package";
import type { ReelRender, ReelRenderRepository } from "@money-maker/core/publishing/reel-render";
import { describe, expect, it, vi } from "vitest";
import { createRenderReelHandler, type RenderReelDependencies } from "./render-reel.js";

vi.mock("@money-maker/providers/http/safe-media-fetch", () => ({
  fetchSafeMedia: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/jpeg",
  })),
}));

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const sourceVariantId = "22222222-2222-4222-8222-222222222222";

const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel",
  label: "Feed",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    captionMaxLength: 2200,
  },
};
const variant: ContentVariant = {
  id: sourceVariantId,
  workspaceId,
  contentItemId: "content-1",
  channelId: channel.id,
  offerSnapshotId: "snapshot-1",
  assetIds: ["asset-1", "asset-2"],
  caption: "#publi x",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
};
const pendingRender: ReelRender = {
  id: "render-1",
  workspaceId,
  sourceVariantId,
  status: "pending",
  voiceMode: "script",
  attempt: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const asset = (id: string): Asset => ({
  id,
  workspaceId,
  objectKey: `workspaces/${workspaceId}/assets/${id}`,
  checksum: "sha256:x",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  provenance: "generated",
  commercialUse: null,
  license: "Generated in ChatGPT",
  state: "active",
});

const job = {
  payload: { version: 1 as const, workspaceId, identifiers: { sourceVariantId } },
};

const baseDependencies = (
  overrides: Partial<RenderReelDependencies> = {},
): RenderReelDependencies => ({
  content: { findVariantForWorkspace: vi.fn(async () => variant) },
  channels: { findForWorkspace: vi.fn(async () => channel) },
  renders: {
    createPending: vi.fn(),
    resetForRetry: vi.fn(),
    findForWorkspace: vi.fn(async () => pendingRender),
    recordReady: vi.fn(async (input: { assetId: string }) => ({
      ...pendingRender,
      status: "ready" as const,
      assetId: input.assetId,
    })),
    recordFailed: vi.fn(async () => ({ ...pendingRender, status: "failed" as const })),
    invalidateReady: vi.fn(),
    recentMusicTrackIds: vi.fn(async () => ["casa/energetic/b.mp3"]),
  } as unknown as ReelRenderRepository,
  assets: {
    createDownload: vi.fn(async () => ({ method: "GET" as const, url: "https://r2.example/a" })),
    putObject: vi.fn(async () => undefined),
  } as unknown as AssetStore,
  assetRepository: {
    findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) => asset(assetId)),
    create: vi.fn(async (created: Asset) => created),
    updateState: vi.fn(async () => asset("asset-1")),
  } as unknown as AssetRepository,
  renderer: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([9, 9, 9]),
      mimeType: "video/mp4" as const,
      width: 1080,
      height: 1920,
      durationMs: 5000,
    })),
  } as ReelRenderer,
  ...overrides,
});

describe("render_reel handler", () => {
  it("renders the carousel's slides and records the render ready with the new asset", async () => {
    const deps = baseDependencies();
    await createRenderReelHandler(deps)(job);

    expect(deps.renderer.render).toHaveBeenCalledWith({
      slides: [
        { bytes: expect.any(Uint8Array), mimeType: "image/jpeg", width: 1080, height: 1350 },
        { bytes: expect.any(Uint8Array), mimeType: "image/jpeg", width: 1080, height: 1350 },
      ],
    });
    expect(deps.assets.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, mimeType: "video/mp4" }),
    );
    expect(deps.assetRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "rendered",
        commercialUse: null,
        metadata: expect.objectContaining({ sourceAssetIds: ["asset-1", "asset-2"] }),
      }),
    );
    expect(deps.assetRepository.updateState).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, state: "active" }),
    );
    expect(deps.assetRepository.updateState).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "archived" }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, sourceVariantId }),
    );
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("moves in-scene slides in 2.5D when scene, depth and text layer exist; others stay still", async () => {
    const layered = (id: string): Asset =>
      id === "asset-1"
        ? { ...asset(id), metadata: { sceneAssetId: "scene-1", overlayAssetId: "overlay-1" } }
        : id === "scene-1"
          ? { ...asset(id), metadata: { depthAssetId: "depth-1" } }
          : asset(id);
    const parallax = vi.fn(async () => new Uint8Array([7, 7]));
    const deps = baseDependencies({
      parallax,
      assetRepository: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) => layered(assetId)),
        create: vi.fn(async (created: Asset) => created),
        updateState: vi.fn(async () => asset("asset-1")),
      } as unknown as AssetRepository,
    });
    await createRenderReelHandler(deps)(job);
    expect(parallax).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, width: 1080, height: 1350, durationSec: 4 }),
    );
    expect(deps.renderer.render).toHaveBeenCalledWith({
      slides: [
        { bytes: new Uint8Array([7, 7]), mimeType: "video/mp4", width: 1080, height: 1920 },
        { bytes: expect.any(Uint8Array), mimeType: "image/jpeg", width: 1080, height: 1350 },
      ],
    });
  });

  it("keeps a still slide when the 2.5D clip fails", async () => {
    const deps = baseDependencies({
      parallax: vi.fn(async () => {
        throw new Error("parallax_encode_failed");
      }),
      assetRepository: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) => ({
          ...asset(assetId),
          metadata: { sceneAssetId: "s", overlayAssetId: "o", depthAssetId: "d" },
        })),
        create: vi.fn(async (created: Asset) => created),
        updateState: vi.fn(async () => asset("asset-1")),
      } as unknown as AssetRepository,
    });
    await createRenderReelHandler(deps)(job);
    const [input] = vi.mocked(deps.renderer.render).mock.calls[0] ?? [];
    expect(input?.slides.map((slide) => slide.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(deps.renders.recordReady).toHaveBeenCalled();
  });

  it("writes each attempt to a fresh object key", async () => {
    const deps = baseDependencies();
    await createRenderReelHandler(deps)(job);
    await createRenderReelHandler(deps)(job);
    const keys = vi
      .mocked(deps.assets.putObject)
      .mock.calls.map(([input]) => (input as { assetId: string }).assetId);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("archives its own asset when another attempt already resolved the render", async () => {
    const deps = baseDependencies({
      renders: {
        ...baseDependencies().renders,
        recordReady: vi.fn(async () => ({
          ...pendingRender,
          status: "ready" as const,
          assetId: "asset-from-the-other-attempt",
        })),
      } as unknown as ReelRenderRepository,
    });
    await createRenderReelHandler(deps)(job);
    const created = vi.mocked(deps.assetRepository.create).mock.calls[0]?.[0] as Asset;
    expect(deps.assetRepository.updateState).toHaveBeenLastCalledWith({
      workspaceId,
      assetId: created.id,
      state: "archived",
    });
  });

  it("mixes the track that fits the niche and hook, skipping the one used last", async () => {
    const track = (id: string) => {
      const [niche = "", mood = ""] = id.split("/");
      return { id, niche, mood: mood as "calm", file: `/music/${id}` };
    };
    const deps = baseDependencies({
      content: {
        findVariantForWorkspace: vi.fn(async () => ({
          ...variant,
          creativeFeatures: {
            hookMove: "contrast" as const,
            angle: "x",
            proofType: "rating" as const,
            urgency: "none" as const,
            priceShown: false,
            discountShown: false,
            ratingShown: true,
          },
        })),
      },
      music: {
        library: {
          listTracks: async () => [
            track("casa/energetic/b.mp3"),
            track("casa/upbeat/c.mp3"),
            track("tech/energetic/t.mp3"),
          ],
        },
        contentItems: {
          findContentItemForWorkspace: vi.fn(async () => ({ nicheId: "niche-1" }) as never),
        },
        niches: {
          findForWorkspace: vi.fn(
            async () => ({ id: "niche-1", name: "Casa", slug: "exampleshop-casa" }) as never,
          ),
        },
      },
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ musicFile: "/music/casa/upbeat/c.mp3" }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ musicTrackId: "casa/upbeat/c.mp3" }),
    );
  });

  it("renders silently when the music lookup fails", async () => {
    const deps = baseDependencies({
      music: {
        library: {
          listTracks: async () => {
            throw new Error("EACCES");
          },
        },
        contentItems: { findContentItemForWorkspace: vi.fn() },
        niches: { findForWorkspace: vi.fn() },
      },
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.not.objectContaining({ musicFile: expect.anything() }),
    );
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("is a no-op when the render is already resolved (not pending)", async () => {
    const deps = baseDependencies({
      renders: {
        createPending: vi.fn(),
        findForWorkspace: vi.fn(async () => ({ ...pendingRender, status: "ready" as const })),
        recordReady: vi.fn(),
        recordFailed: vi.fn(),
      } as unknown as ReelRenderRepository,
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.content.findVariantForWorkspace).not.toHaveBeenCalled();
  });

  it("records a failure when the channel is not instagram_carousel", async () => {
    const deps = baseDependencies({
      channels: {
        findForWorkspace: vi.fn(async (): Promise<Channel> => ({ ...channel, kind: "threads" })),
      },
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, sourceVariantId, reason: "channel_not_carousel" }),
    );
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  it("records a failure when a slide asset is missing", async () => {
    const deps = baseDependencies({
      assetRepository: {
        findForWorkspace: vi.fn(async () => null),
        create: vi.fn(),
        updateState: vi.fn(),
      } as unknown as AssetRepository,
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "asset_unavailable" }),
    );
  });

  it("records a failure when the renderer throws", async () => {
    const deps = baseDependencies({
      renderer: { render: vi.fn(async () => Promise.reject(new Error("reel_render_failed"))) },
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "reel_render_failed" }),
    );
  });
});

describe("render_reel handler, voice-over", () => {
  const voicedVariant: ContentVariant = { ...variant, voiceScript: ["Frase um.", "Frase dois."] };

  const synthesizedClip = (voiceId: string) => ({
    bytes: new Uint8Array([voiceId.length]),
    mimeType: "audio/wav" as const,
    durationMs: 2000,
    words: [{ text: "Frase", startMs: 0, endMs: 400 }],
  });

  const speechDeps = (
    overrides: Partial<{
      synthesizer: SpeechSynthesizer;
      nicheContext: Record<string, unknown> | null;
    }> = {},
  ) => ({
    synthesizer:
      overrides.synthesizer ??
      ({
        synthesize: vi.fn(async ({ voiceId }: { voiceId: string }) => synthesizedClip(voiceId)),
      } as SpeechSynthesizer),
    defaultVoiceId: "pf_dora",
    contentItems: {
      findContentItemForWorkspace: vi.fn(async () => ({ nicheId: "niche-1" }) as never),
    },
    niches: {
      findForWorkspace: vi.fn(
        async () =>
          ({
            id: "niche-1",
            name: "Casa",
            context: overrides.nicheContext ?? { voiceId: "pm_alex" },
          }) as never,
      ),
    },
  });

  it("passes workspaceId to the synthesizer and records tts cache counts", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValueOnce({ ...synthesizedClip("pm_alex"), cached: true })
      .mockResolvedValueOnce({ ...synthesizedClip("pm_alex"), cached: false });
    const quality = { version: 1 as const, verdict: "pass" as const, checks: [], measuredAt: "t" };
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech: speechDeps({ synthesizer: { synthesize } as SpeechSynthesizer }),
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([9]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 4000,
          quality,
        })),
      } as ReelRenderer,
    });
    await createRenderReelHandler(deps)(job);
    expect(synthesize).toHaveBeenNthCalledWith(1, {
      text: "Frase um.",
      voiceId: "pm_alex",
      language: "pt-BR",
      workspaceId,
    });
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityReport: expect.objectContaining({ cacheHits: { tts: { hit: 1, miss: 1 } } }),
      }),
    );
  });

  it("narrates each slide with the niche's voice and renders with the timeline", async () => {
    const speech = speechDeps();
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(speech.synthesizer.synthesize).toHaveBeenCalledTimes(2);
    expect(speech.synthesizer.synthesize).toHaveBeenNthCalledWith(1, {
      text: "Frase um.",
      voiceId: "pm_alex",
      language: "pt-BR",
      workspaceId,
    });
    expect(speech.synthesizer.synthesize).toHaveBeenNthCalledWith(2, {
      text: "Frase dois.",
      voiceId: "pm_alex",
      language: "pt-BR",
      workspaceId,
    });
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceClips: [expect.any(Uint8Array), expect.any(Uint8Array)],
        timeline: expect.objectContaining({ slides: expect.any(Array) }),
      }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "pm_alex", durationMs: expect.any(Number) }),
    );
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("passes the resolved caption theme only when the niche configures one", async () => {
    const themed = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech: speechDeps({ nicheContext: { captionTheme: { preset: "karaoke" } } }),
    });
    await createRenderReelHandler(themed)(job);
    expect(themed.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        captionStyle: { theme: expect.objectContaining({ id: "karaoke", marginV: 576 }) },
      }),
    );
    const plain = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech: speechDeps(),
    });
    await createRenderReelHandler(plain)(job);
    expect(plain.renderer.render).toHaveBeenCalledWith(
      expect.not.objectContaining({ captionStyle: expect.anything() }),
    );
  });

  it("falls back to the default voice when the niche has none", async () => {
    const speech = speechDeps({ nicheContext: {} });
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(speech.synthesizer.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "pf_dora" }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "pf_dora" }),
    );
  });

  it("records a voice_failed reason when synthesis fails, and never renders", async () => {
    const speech = speechDeps({
      synthesizer: {
        synthesize: vi.fn(async () => Promise.reject(new Error("voice_synthesis_failed:500"))),
      },
    });
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "voice_failed:voice_synthesis_failed:500" }),
    );
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  it("hands a voice timeout back for a retry while attempts remain, then fails", async () => {
    const speech = speechDeps({
      synthesizer: {
        synthesize: vi.fn(async () => Promise.reject(new Error("voice_synthesis_failed:timeout"))),
      },
    });
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech,
    });
    await expect(createRenderReelHandler(deps)({ ...job, attemptCount: 1 })).rejects.toThrow(
      "voice_synthesis_failed:timeout",
    );
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
    await createRenderReelHandler(deps)({ ...job, attemptCount: 2 });
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "voice_failed:voice_synthesis_failed:timeout" }),
    );
  });

  it("enqueues the narration check for a voiced ready render and never for a silent one", async () => {
    const jobs = { enqueue: vi.fn(async () => ({}) as never) };
    const voiced = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech: speechDeps(),
      jobs,
    });
    await createRenderReelHandler(voiced)(job);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "check_narration",
        payload: expect.objectContaining({
          identifiers: { sourceVariantId, assetId: expect.any(String) },
        }),
      }),
    );

    const silent = baseDependencies({ jobs });
    await createRenderReelHandler(silent)(job);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps the render ready when the narration check cannot be enqueued", async () => {
    const jobs = {
      enqueue: vi.fn(async () => {
        throw new Error("queue down");
      }),
    };
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech: speechDeps(),
      jobs,
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordReady).toHaveBeenCalled();
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("skips narration when the render's voiceMode is none", async () => {
    const speech = speechDeps();
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      renders: {
        createPending: vi.fn(),
        resetForRetry: vi.fn(),
        findForWorkspace: vi.fn(async () => ({ ...pendingRender, voiceMode: "none" as const })),
        recordReady: vi.fn(async () => ({ ...pendingRender, status: "ready" as const })),
        recordFailed: vi.fn(async () => ({ ...pendingRender, status: "failed" as const })),
        recentMusicTrackIds: vi.fn(async () => []),
      } as unknown as ReelRenderRepository,
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(speech.synthesizer.synthesize).not.toHaveBeenCalled();
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.not.objectContaining({ voiceClips: expect.anything() }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.not.objectContaining({ voiceId: expect.anything() }),
    );
  });

  it("records voice_failed:voice_unavailable when there is a script but no speech dependency", async () => {
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
    });
    await createRenderReelHandler(deps)(job);

    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "voice_failed:voice_unavailable" }),
    );
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  it("records voice_failed:reel_too_long when the narrated slides overrun the timeline budget", async () => {
    const longVariant: ContentVariant = {
      ...variant,
      assetIds: Array.from({ length: 10 }, (_, i) => `asset-${i}`),
      voiceScript: Array.from({ length: 10 }, () => "Frase longa."),
    };
    const speech = speechDeps({
      synthesizer: {
        synthesize: vi.fn(async () => ({
          bytes: new Uint8Array([1]),
          mimeType: "audio/wav" as const,
          durationMs: 6000,
          words: [],
        })),
      },
    });
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => longVariant) },
      assetRepository: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) => asset(assetId)),
        create: vi.fn(),
        updateState: vi.fn(),
      } as unknown as AssetRepository,
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/^voice_failed:reel_too_long:/) }),
    );
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });

  it("still renders ready when the synthesizer returns no word timestamps", async () => {
    const speech = speechDeps({
      synthesizer: {
        synthesize: vi.fn(async () => ({
          bytes: new Uint8Array([1]),
          mimeType: "audio/wav" as const,
          durationMs: 2000,
          words: [],
        })),
      },
    });
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => voicedVariant) },
      speech,
    });
    await createRenderReelHandler(deps)(job);

    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "pm_alex" }),
    );
  });

  it("records a quality-blocked render as failed and stores no video asset", async () => {
    const quality = {
      version: 1 as const,
      verdict: "block" as const,
      checks: [
        { id: "audio_stream" as const, verdict: "block" as const, detail: "no audio stream" },
        { id: "black" as const, verdict: "block" as const },
      ],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const deps = baseDependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([9]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 5000,
          quality,
        })),
      } as ReelRenderer,
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith({
      workspaceId,
      sourceVariantId,
      reason: "quality_blocked:audio_stream,black",
      qualityReport: {
        ...quality,
        checks: [...quality.checks, { id: "music", verdict: "warn", detail: expect.any(String) }],
      },
    });
    expect(deps.assets.putObject).not.toHaveBeenCalled();
    expect(deps.assetRepository.create).not.toHaveBeenCalled();
    expect(deps.renders.recordReady).not.toHaveBeenCalled();
  });

  it("records a render with quality warnings as ready and keeps the report", async () => {
    const quality = {
      version: 1 as const,
      verdict: "warn" as const,
      checks: [{ id: "loudness" as const, verdict: "warn" as const, detail: "-18 LUFS" }],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const deps = baseDependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([9]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 5000,
          quality,
        })),
      } as ReelRenderer,
    });
    await createRenderReelHandler(deps)(job);
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityReport: expect.objectContaining({
          verdict: "warn",
          checks: [...quality.checks, expect.objectContaining({ id: "music", verdict: "warn" })],
        }),
      }),
    );
  });

  it("warns in the quality report when no licensed track is mixed in, passes with one", async () => {
    const quality = {
      version: 1 as const,
      verdict: "pass" as const,
      checks: [],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const renderer = {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([9]),
        mimeType: "video/mp4" as const,
        width: 1080,
        height: 1920,
        durationMs: 5000,
        quality,
      })),
    } as ReelRenderer;
    const silent = baseDependencies({ renderer });
    await createRenderReelHandler(silent)(job);
    expect(silent.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityReport: expect.objectContaining({
          verdict: "warn",
          checks: [expect.objectContaining({ id: "music", verdict: "warn" })],
        }),
      }),
    );
    const withMusic = baseDependencies({
      renderer,
      music: {
        library: {
          listTracks: async () => [
            {
              id: "casa/calm/a.mp3",
              niche: "casa",
              mood: "calm" as const,
              file: "/music/a.mp3",
              license: "CC0",
            },
          ],
        },
        contentItems: { findContentItemForWorkspace: vi.fn(async () => null) },
        niches: { findForWorkspace: vi.fn(async () => null) },
      },
    });
    await createRenderReelHandler(withMusic)(job);
    expect(withMusic.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        musicTrackId: "casa/calm/a.mp3",
        qualityReport: expect.objectContaining({
          verdict: "pass",
          checks: [expect.objectContaining({ id: "music", verdict: "pass" })],
        }),
      }),
    );
  });

  it("gives TikTok its own edition when the Reel's track is licensed on Meta only", async () => {
    const offerId = "offer-1";
    const itemId = uuidFromKey(`auto-sale:${offerId}`);
    const source = { ...variant, contentItemId: itemId, state: "draft" as const };
    const reelChannel = (id: string, kind: Channel["kind"]) => ({ ...channel, id, kind });
    let drafts: ContentVariant[] = [
      { ...source, id: "ig", channelId: "ig-ch", assetIds: [] },
      { ...source, id: "tt", channelId: "tt-ch", assetIds: [] },
    ];
    const meta = {
      id: "casa/calm/meta.m4a",
      niche: "casa",
      mood: "calm" as const,
      file: "/music/meta.m4a",
      license: "Meta Sound Collection",
      platforms: ["instagram", "facebook"] as const,
    };
    const tiktok = {
      ...meta,
      id: "casa/calm/tt.m4a",
      file: "/music/tt.m4a",
      platforms: ["tiktok"] as const,
    };
    const deps = baseDependencies({
      content: { findVariantForWorkspace: vi.fn(async () => source) },
      music: {
        library: { listTracks: async () => [meta, tiktok] },
        contentItems: { findContentItemForWorkspace: vi.fn(async () => null) },
        niches: { findForWorkspace: vi.fn(async () => null) },
      },
      autoReels: {
        content: {
          findContentItemForWorkspace: vi.fn(async () => ({ id: itemId, offerId })),
          listVariantsForWorkspace: vi.fn(async () => drafts),
          updateVariant: vi.fn(async (next: ContentVariant) => {
            drafts = drafts.map((d) => (d.id === next.id ? next : d));
            return next;
          }),
        },
        channels: {
          findForWorkspace: vi.fn(async () => channel),
          listForWorkspace: vi.fn(async () => [
            channel,
            reelChannel("ig-ch", "instagram_reels"),
            reelChannel("tt-ch", "tiktok_video"),
          ]),
        },
      } as unknown as NonNullable<RenderReelDependencies["autoReels"]>,
    });
    await createRenderReelHandler(deps)(job);
    const renders = (deps.renderer.render as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => (input as { musicFile?: string }).musicFile,
    );
    expect(renders).toEqual(["/music/meta.m4a", "/music/tt.m4a"]);
    const [igVideo, ttVideo] = drafts.map((d) => d.assetIds[0]);
    expect(igVideo).toBeDefined();
    expect(ttVideo).toBeDefined();
    expect(ttVideo).not.toBe(igVideo);
    expect(deps.assetRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ edition: "tiktok", musicTrackId: "casa/calm/tt.m4a" }),
      }),
    );
  });

  it("records render_timeout when the deadline aborts the render", async () => {
    const controller = new AbortController();
    const deps = baseDependencies({
      renderer: {
        render: vi.fn(async () => {
          controller.abort(new Error("render_timeout"));
          throw new Error("render_aborted");
        }),
      } as ReelRenderer,
    });
    await createRenderReelHandler(deps)(job, { signal: controller.signal });
    expect(deps.renders.recordFailed).toHaveBeenCalledWith({
      workspaceId,
      sourceVariantId,
      reason: "render_timeout",
    });
  });

  it("hands a shutdown-aborted render back for a retry while attempts remain", async () => {
    const controller = new AbortController();
    const deps = baseDependencies({
      renderer: {
        render: vi.fn(async () => {
          controller.abort(new Error("worker_shutdown"));
          throw new Error("render_aborted");
        }),
      } as ReelRenderer,
    });
    await expect(
      createRenderReelHandler(deps)({ ...job, attemptCount: 1 }, { signal: controller.signal }),
    ).rejects.toThrow("render_aborted");
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });
});
