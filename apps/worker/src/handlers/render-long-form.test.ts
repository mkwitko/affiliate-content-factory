import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { ContentScript } from "@money-maker/core/content/editorial";
import type { SceneClipState } from "@money-maker/core/content/scene-clip-state";
import {
  createStoryboard,
  type Storyboard,
  type StoryboardScene,
} from "@money-maker/core/content/storyboard";
import type { LongFormRender } from "@money-maker/core/publishing/long-form-render";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { describe, expect, it, vi } from "vitest";
import {
  createRenderLongFormHandler,
  type RenderLongFormDependencies,
} from "./render-long-form.js";

vi.mock("@money-maker/providers/http/safe-media-fetch", () => ({
  fetchSafeMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), mimeType: "image/png" })),
}));
const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = "22222222-2222-4222-8222-222222222222" as ContentScript["actorId"];
const script: ContentScript = {
  id: "script-1",
  workspaceId,
  contentItemId: "item-1",
  version: 1,
  status: "approved",
  body: "Hello world",
  language: "en",
  claims: [],
  beats: [],
  checksum: "a".repeat(64),
  createdAt: new Date(),
  actorId,
  approvedBy: actorId,
  approvedAt: new Date(),
  approvedChecksum: "a".repeat(64),
};
const storyboard: Storyboard = {
  id: "board-1",
  workspaceId,
  contentItemId: "item-1",
  scriptId: script.id,
  version: 1,
  renderer: "slideshow",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 11,
      assetId: "scene-1",
      motion: "static",
      captionMode: "line",
    },
  ],
  voiceId: "pf_dora",
  musicTrackId: null,
  canvas: "landscape",
  checksum: "b".repeat(64),
  createdAt: new Date(),
  actorId,
};
const render: LongFormRender = {
  id: "render-1",
  workspaceId,
  storyboardId: storyboard.id,
  attempt: 1,
  status: "pending",
  rendererVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const source: Asset = {
  id: "scene-1",
  workspaceId,
  objectKey: "key",
  checksum: "c".repeat(64),
  mimeType: "image/png",
  width: 1280,
  height: 720,
  provenance: "generated",
  license: "licensed",
  commercialUse: true,
  state: "active",
};
const job = { payload: { version: 1 as const, workspaceId, identifiers: { renderId: render.id } } };
const dependencies = (
  overrides: Partial<RenderLongFormDependencies> = {},
): RenderLongFormDependencies => ({
  storyboards: { findForWorkspace: vi.fn(async () => storyboard) } as never,
  scripts: { findScriptForWorkspace: vi.fn(async () => script) } as never,
  renders: {
    findForWorkspace: vi.fn(async () => render),
    recordReady: vi.fn(async () => ({ ...render, status: "ready" as const })),
    recordFailed: vi.fn(async () => ({ ...render, status: "failed" as const })),
  } as never,
  assets: {
    findForWorkspace: vi.fn(async () => source),
    create: vi.fn(async (asset: Asset) => asset),
    updateState: vi.fn(async () => source),
  } as never,
  store: {
    createDownload: vi.fn(async () => ({ url: "https://asset.test/scene.png" })),
    putObject: vi.fn(async () => undefined),
  } as never,
  speech: {
    synthesize: vi.fn(async () => ({
      bytes: new Uint8Array([3]),
      mimeType: "audio/wav" as const,
      durationMs: 1000,
      words: [
        { text: "Hello", startMs: 0, endMs: 450 },
        { text: "world", startMs: 500, endMs: 900 },
      ],
    })),
  },
  renderer: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([4, 5]),
      mimeType: "video/mp4" as const,
      width: 1920,
      height: 1080,
      durationMs: 2500,
    })),
  } as never,
  ...overrides,
});

describe("render_long_form handler", () => {
  it("composes existing storyboard assets into an inheriting rendered asset", async () => {
    const deps = dependencies();
    await createRenderLongFormHandler(deps)(job);
    expect(deps.speech.synthesize).toHaveBeenCalledOnce();
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: "landscape", motions: ["static"] }),
    );
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "rendered",
        commercialUse: null,
        metadata: expect.objectContaining({
          scriptChecksum: script.checksum,
          sourceAssetIds: ["scene-1"],
        }),
      }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 2500,
        timingManifest: expect.objectContaining({
          alignmentStatus: "aligned",
          scriptChecksum: script.checksum,
          storyboardChecksum: storyboard.checksum,
          renderedAssetId: expect.any(String),
          scenes: [
            expect.objectContaining({
              fromChar: 0,
              toChar: script.body.length,
              sourceAssetChecksum: source.checksum,
            }),
          ],
          words: [
            expect.objectContaining({ text: "Hello", fromChar: 0, toChar: 5 }),
            expect.objectContaining({ text: "world", fromChar: 6, toChar: 11 }),
          ],
        }),
      }),
    );
  });

  it("preserves word timings when captions are disabled without sending captions to the renderer", async () => {
    const scene = storyboard.scenes[0];
    if (!scene) throw new Error("test_scene_missing");
    const noCaptionsBoard: Storyboard = {
      ...storyboard,
      scenes: [{ ...(scene as StoryboardScene), captionMode: "none" }],
    };
    const deps = dependencies({
      storyboards: { findForWorkspace: vi.fn(async () => noCaptionsBoard) } as never,
    });

    await createRenderLongFormHandler(deps)(job);

    const renderInput = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
    expect(renderInput?.timeline?.slides[0]?.words).toEqual([]);
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        timingManifest: expect.objectContaining({
          alignmentStatus: "aligned",
          words: [
            expect.objectContaining({ text: "Hello", startMs: 0, fromChar: 0, toChar: 5 }),
            expect.objectContaining({ text: "world", startMs: 500, fromChar: 6, toChar: 11 }),
          ],
        }),
      }),
    );
  });

  it("keeps line captions as one renderer caption while retaining per-word timing", async () => {
    const deps = dependencies();

    await createRenderLongFormHandler(deps)(job);

    const renderInput = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
    expect(renderInput?.timeline?.slides[0]?.words).toEqual([
      expect.objectContaining({ text: "Hello world" }),
    ]);
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        timingManifest: expect.objectContaining({
          words: expect.arrayContaining([
            expect.objectContaining({ text: "Hello" }),
            expect.objectContaining({ text: "world" }),
          ]),
        }),
      }),
    );
  });

  it("does not mark a render ready when the final duration cannot contain the timeline", async () => {
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1920,
          height: 1080,
          durationMs: 1000,
        })),
      } as never,
    });

    await createRenderLongFormHandler(deps)({ ...job, attemptCount: 2 });

    expect(deps.renders.recordReady).not.toHaveBeenCalled();
    expect(deps.store.putObject).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "long_form_timing_manifest_invalid" }),
    );
  });

  it("records a quality-blocked render as failed without storing the video", async () => {
    const quality = {
      version: 1 as const,
      verdict: "block" as const,
      checks: [{ id: "freeze" as const, verdict: "block" as const, detail: "longest 7s" }],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1920,
          height: 1080,
          durationMs: 2500,
          quality,
        })),
      } as never,
    });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith({
      workspaceId,
      renderId: render.id,
      reason: "quality_blocked:freeze",
      qualityReport: quality,
    });
    expect(deps.store.putObject).not.toHaveBeenCalled();
    expect(deps.assets.create).not.toHaveBeenCalled();
    expect(deps.renders.recordReady).not.toHaveBeenCalled();
  });

  it("passes a non-blocking quality report to the ready render", async () => {
    const quality = {
      version: 1 as const,
      verdict: "pass" as const,
      checks: [],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1920,
          height: 1080,
          durationMs: 2500,
          quality,
        })),
      } as never,
    });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ qualityReport: quality }),
    );
  });

  it("passes workspaceId to the synthesizer and records tts cache counts", async () => {
    const quality = {
      version: 1 as const,
      verdict: "pass" as const,
      checks: [],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const synthesize = vi.fn(async () => ({
      bytes: new Uint8Array([3]),
      mimeType: "audio/wav" as const,
      durationMs: 1000,
      words: [{ text: "Hello", startMs: 0, endMs: 450 }],
      cached: true,
    }));
    const deps = dependencies({
      speech: { synthesize },
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1920,
          height: 1080,
          durationMs: 2500,
          quality,
        })),
      } as never,
    });
    await createRenderLongFormHandler(deps)(job);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityReport: { ...quality, cacheHits: { tts: { hit: 1, miss: 0 } } },
      }),
    );
  });

  it("records render_timeout when the job deadline aborts the render", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      renderer: {
        render: vi.fn(async (_input: unknown, options?: { signal?: AbortSignal }) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort(new Error("render_timeout"));
          throw new Error("render_aborted");
        }),
      } as never,
    });
    await createRenderLongFormHandler(deps)(job, { signal: controller.signal });
    expect(deps.renders.recordFailed).toHaveBeenCalledWith({
      workspaceId,
      renderId: render.id,
      reason: "render_timeout",
    });
    expect(deps.store.putObject).not.toHaveBeenCalled();
  });

  it("hands a shutdown-aborted render back for a retry without failing it", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => {
          controller.abort(new Error("worker_shutdown"));
          throw new Error("render_aborted");
        }),
      } as never,
    });
    await expect(
      createRenderLongFormHandler(deps)({ ...job, attemptCount: 1 }, { signal: controller.signal }),
    ).rejects.toThrow("render_aborted");
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("stops before narration when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("render_timeout"));
    const deps = dependencies();
    await createRenderLongFormHandler(deps)(job, { signal: controller.signal });
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "render_timeout" }),
    );
  });

  it("fails permanently when a storyboard scene asset is missing", async () => {
    const deps = dependencies({ assets: { findForWorkspace: vi.fn(async () => null) } as never });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scene_asset_missing:1" }),
    );
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });
});

describe("render_long_form handler for stickman_still storyboards", () => {
  const body = "Milk sits at the back. Stores want you walking. You pass everything else.";
  const stickScript: ContentScript = { ...script, body };
  const cast = (keys: readonly string[]) =>
    keys.map((key) => ({
      key,
      name: key,
      role: "main" as const,
      rigId: "stick-v1" as const,
      rigVersion: 1 as const,
      palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
    }));
  const spec = (
    index: number,
    fromChar: number,
    toChar: number,
    over: Record<string, unknown>,
  ) => ({
    index,
    fromChar,
    toChar,
    purpose: "explanation",
    background: "store",
    actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "left" }],
    props: [],
    overlays: [],
    camera: { shot: "medium", movement: "none" },
    transition: "hard_cut",
    captionMode: "word",
    ...over,
  });
  const board = (secondActor = "alex") =>
    createStoryboard({
      id: "board-stick",
      workspaceId,
      script: { ...stickScript, approvedChecksum: stickScript.checksum },
      version: 1,
      renderer: "stickman_still",
      scenes: [
        spec(1, 0, 22, { purpose: "hook" }),
        spec(2, 22, 47, {
          background: "bank",
          camera: { shot: "wide", movement: "slow_zoom_in" },
          actors: [
            {
              characterKey: secondActor,
              pose: "thinking",
              expression: "confused",
              position: "right",
            },
          ],
        }),
        spec(3, 47, body.length, {
          purpose: "payoff",
          props: [{ type: "milk_carton", position: "right" }],
        }),
      ] as never,
      assets: [],
      characters: cast(["alex", "sam"]),
      voiceId: "af_heart",
      canvas: "portrait",
      actorId,
    });
  const mediaNiche = (keys: readonly string[]) => ({
    id: "niche-1",
    workspaceId,
    kind: "media" as const,
    context: { characters: cast(keys) },
  });
  const stickDeps = (
    options: {
      board?: Storyboard;
      castKeys?: readonly string[];
      kind?: "media" | "affiliate";
      explainer?: Record<string, unknown>;
    } = {},
  ) => {
    const costEvents: { provider: string; status: string }[] = [];
    const deps = dependencies({
      storyboards: { findForWorkspace: vi.fn(async () => options.board ?? board()) } as never,
      scripts: {
        findScriptForWorkspace: vi.fn(async () => ({
          ...stickScript,
          approvedChecksum: stickScript.checksum,
        })),
      } as never,
      content: {
        findContentItemForWorkspace: vi.fn(async () => ({ id: "item-1", nicheId: "niche-1" })),
      } as never,
      niches: {
        findForWorkspace: vi.fn(async () => {
          const niche = mediaNiche(options.castKeys ?? ["alex", "sam"]);
          return {
            ...niche,
            kind: options.kind ?? "media",
            ...(options.explainer
              ? { context: { ...niche.context, explainer: options.explainer } }
              : {}),
          };
        }),
      } as never,
      rasterizer: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 12_000,
        })),
      } as never,
      costs: {
        create: vi.fn(async (event: { provider: string; status: string }) => {
          costEvents.push({ ...event });
          return event;
        }),
        settle: vi.fn(async ({ id }: { id: string }) => {
          const event = costEvents.find((entry) => (entry as { id?: string }).id === id);
          if (event) event.status = "settled";
          return event ?? null;
        }),
      } as never,
    });
    return { deps, costEvents };
  };

  it("composes stills without fetching assets and uses the media caption band", async () => {
    vi.mocked(fetchSafeMedia).mockClear();
    const { deps } = stickDeps();
    await createRenderLongFormHandler(deps)(job);
    expect(fetchSafeMedia).not.toHaveBeenCalled();
    expect(deps.rasterizer).toHaveBeenCalledTimes(3);
    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: "portrait",
        motions: ["static", "ken_burns_in", "static"],
        captionStyle: { marginV: 670, groupSize: 3, boxed: true },
        slides: [
          expect.objectContaining({ mimeType: "image/png", width: 1080, height: 1920 }),
          expect.anything(),
          expect.anything(),
        ],
      }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        timingManifest: expect.objectContaining({
          scenes: [
            expect.objectContaining({
              sourceAssetId: "scene-spec:1",
              sourceAssetChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            expect.anything(),
            expect.anything(),
          ],
        }),
      }),
    );
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ renderer: "stickman_still" }),
      }),
    );
  });

  it("fails naming the scene when its character left the cast, before any narration", async () => {
    const { deps } = stickDeps({ board: board("sam"), castKeys: ["alex"] });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scene_character_missing:2" }),
    );
  });

  it("fails when the niche is no longer a media niche", async () => {
    const { deps } = stickDeps({ kind: "affiliate" });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "explainer_context_missing" }),
    );
  });

  const motionBoard = (actors?: readonly Record<string, unknown>[]) =>
    createStoryboard({
      ...{
        id: "board-motion",
        workspaceId,
        script: { ...stickScript, approvedChecksum: stickScript.checksum },
        version: 1,
        renderer: "stickman_motion",
        scenes: [
          spec(1, 0, 22, {
            purpose: "hook",
            ...(actors ? { actors } : {}),
          }),
          spec(2, 22, 47, {
            background: "bank",
            transition: "wipe",
            camera: { shot: "wide", movement: "none" },
          }),
          spec(3, 47, body.length, { purpose: "payoff" }),
        ] as never,
        assets: [],
        characters: cast(["alex", "sam"]),
        voiceId: "af_heart",
        canvas: "portrait",
        actorId,
      },
    });
  const motionRenderer = () => ({
    render: vi.fn(async (input: { plan: { durationMs: number } }) => ({
      bytes: new Uint8Array([7, 7]),
      mimeType: "video/mp4" as const,
      width: 1080,
      height: 1920,
      durationMs: input.plan.durationMs,
      quality: {
        version: 1 as const,
        verdict: "pass" as const,
        checks: [],
        measuredAt: "2026-10-01T00:00:00.000Z",
      },
    })),
  });

  it("animates stickman_motion boards with the motion renderer instead of stills", async () => {
    const motion = motionRenderer();
    const controller = new AbortController();
    const { deps } = stickDeps({ board: motionBoard() });
    const handler = createRenderLongFormHandler({ ...deps, motionRenderer: motion as never });
    await handler(job, { signal: controller.signal });
    expect(deps.rasterizer).not.toHaveBeenCalled();
    expect(deps.renderer.render).not.toHaveBeenCalled();
    expect(deps.speech.synthesize).toHaveBeenCalledTimes(3);
    const [input, options] = motion.render.mock.calls[0] as unknown as [
      {
        plan: { scenes: { spec: { index: number } }[]; durationMs: number };
        voiceClips: unknown[];
        voiceStartMs: number[];
      },
      { signal: AbortSignal },
    ];
    expect(input.plan.scenes.map((entry) => entry.spec.index)).toEqual([1, 2, 3]);
    expect(input.voiceClips).toHaveLength(3);
    // 1 s clips hold the 2.5 s minimum; motion scenes overlap by a 300 ms transition, so the
    // second scene enters at 2.2 s and its narration starts once it is fully on screen.
    expect(input.voiceStartMs[1]).toBe(2_500);
    expect(options.signal).toBe(controller.signal);
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ renderer: "stickman_motion" }),
      }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: input.plan.durationMs,
        qualityReport: expect.objectContaining({ verdict: "pass" }),
      }),
    );
  });

  it("hands the renderer a chunk cache over the stage cache and keeps the timing manifest identical", async () => {
    const plain = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler({
      ...plain.deps,
      motionRenderer: motionRenderer() as never,
    })(job);

    const motion = motionRenderer();
    const getOrProduce = vi.fn(
      async (request: { produce: () => Promise<{ bytes: Uint8Array }> }) => ({
        ...(await request.produce()),
        hit: false,
        assetId: "cache-1",
        mimeType: "video/mp4",
        metadata: {},
      }),
    );
    const chunked = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler({
      ...chunked.deps,
      motionRenderer: motion as never,
      chunkStore: { getOrProduce },
      codeVersion: "abc1234",
    })(job);
    const [input] = motion.render.mock.calls[0] as unknown as [
      {
        chunks: {
          sourceKey: string;
          rendererVersion: number;
          codeVersion: string;
          cache: (id: string, produce: () => Promise<Uint8Array>) => Promise<Uint8Array>;
        };
      },
    ];
    expect(input.chunks).toMatchObject({ sourceKey: expect.any(String), codeVersion: "abc1234" });
    const bytes = await input.chunks.cache("identity-1", async () => new Uint8Array([1, 2, 3]));
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(getOrProduce).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, stage: "motion_chunk", inputs: "identity-1" }),
    );
    const manifest = (deps: typeof plain.deps) =>
      vi.mocked(deps.renders.recordReady).mock.calls[0]?.[0].timingManifest as unknown as {
        durationMs: number;
        scenes: unknown[];
        words: unknown[];
      };
    const a = manifest(plain.deps);
    const b = manifest(chunked.deps);
    expect(b.scenes).toEqual(a.scenes);
    expect(b.words).toEqual(a.words);
    expect(b.durationMs).toBe(a.durationMs);
    expect(b.scenes).toHaveLength(3);
  });

  it("does not reuse chunks when the build version is unknown", async () => {
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      chunkStore: { getOrProduce: vi.fn() },
    })(job);
    const [input] = motion.render.mock.calls[0] as unknown as [{ chunks: { cache?: unknown } }];
    expect(input.chunks.cache).toBeUndefined();
  });

  it("fails a motion board at the thumbnail gate before the full render", async () => {
    const motion = motionRenderer();
    // The gate blocks only niches that opted into v2 (here: the motion grammar).
    const { deps } = stickDeps({ board: motionBoard(), explainer: { motionGrammar: true } });
    const visualQa = {
      thumbnail: vi.fn(async () => [
        { id: "caption_contrast", severity: "BLOCK" as const },
        { id: "hero_area", severity: "WARN" as const },
      ]),
      report: vi.fn(),
    };
    await createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      visualQa,
    })(job);
    expect(motion.render).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith({
      workspaceId,
      renderId: render.id,
      reason: "thumbnail_check:caption_contrast",
    });
    expect(deps.assets.create).not.toHaveBeenCalled();
  });

  it("never blocks a niche that did not opt into v2 at the thumbnail gate", async () => {
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: motionBoard() });
    const visualQa = {
      thumbnail: vi.fn(async () => [{ id: "caption_contrast", severity: "BLOCK" as const }]),
      report: vi.fn(async () => ({ findings: [], colorStrip: [] })),
    };
    await createRenderLongFormHandler({ ...deps, motionRenderer: motion as never, visualQa })(job);
    expect(visualQa.thumbnail).not.toHaveBeenCalled();
    expect(motion.render).toHaveBeenCalled();
    expect(deps.renders.recordFailed).not.toHaveBeenCalled();
  });

  it("stores the visual section on the quality report and ignores a failing inspection", async () => {
    const visual = {
      findings: [{ id: "hero_area", severity: "WARN" as const }],
      colorStrip: ["#808080"],
    };
    const { deps } = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler({
      ...deps,
      motionRenderer: motionRenderer() as never,
      visualQa: { thumbnail: async () => [], report: async () => visual },
    })(job);
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({ qualityReport: expect.objectContaining({ visual }) }),
    );
    const again = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler({
      ...again.deps,
      motionRenderer: motionRenderer() as never,
      visualQa: {
        thumbnail: async () => Promise.reject(new Error("sharp")),
        report: async () => Promise.reject(new Error("sharp")),
      },
    })(job);
    expect(again.deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityReport: expect.not.objectContaining({ visual: expect.anything() }),
      }),
    );
  });

  it("fails a motion board whose character left the cast before any narration", async () => {
    const { deps } = stickDeps({ board: motionBoard(), castKeys: ["sam"] });
    await createRenderLongFormHandler({ ...deps, motionRenderer: motionRenderer() as never })(job);
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scene_character_missing:1" }),
    );
  });

  it("fails a motion board when the worker has no motion renderer", async () => {
    const { deps } = stickDeps({ board: motionBoard() });
    await createRenderLongFormHandler(deps)(job);
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "motion_renderer_unavailable" }),
    );
  });

  const painting: Asset = {
    ...source,
    id: "bg-1",
    width: 1024,
    height: 1024,
    metadata: { role: "explainer_background" },
  };
  const paintedBoard = () =>
    createStoryboard({
      id: "board-painted",
      workspaceId,
      script: { ...stickScript, approvedChecksum: stickScript.checksum },
      version: 1,
      renderer: "stickman_motion",
      scenes: [
        spec(1, 0, 22, { purpose: "hook", backgroundAssetId: "bg-1" }),
        spec(2, 22, 47, {
          background: "bank",
          transition: "wipe",
          camera: { shot: "wide", movement: "none" },
        }),
        spec(3, 47, body.length, { purpose: "payoff" }),
      ] as never,
      assets: [painting],
      characters: cast(["alex", "sam"]),
      voiceId: "af_heart",
      canvas: "portrait",
      actorId,
    });
  type PlanInput = {
    plan: { scenes: { art?: { href: string } }[]; notes: readonly string[] };
  };

  it("draws the painted background from its asset and credits it as a source", async () => {
    vi.mocked(fetchSafeMedia).mockClear();
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: paintedBoard() });
    const handler = createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      assets: { ...deps.assets, findForWorkspace: vi.fn(async () => painting) } as never,
    });
    await handler(job);
    const [input] = motion.render.mock.calls[0] as unknown as [PlanInput];
    expect(input.plan.scenes[0]?.art).toEqual({ href: "data:image/png;base64,AQI=" });
    expect(input.plan.scenes[1]?.art).toBeUndefined();
    expect(input.plan.notes).not.toContain("background_fallback:1");
    expect(fetchSafeMedia).toHaveBeenCalledTimes(1);
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ sourceAssetIds: ["bg-1"] }) }),
    );
  });

  it("falls back to the procedural setting when the background lost its rights", async () => {
    vi.mocked(fetchSafeMedia).mockClear();
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: paintedBoard() });
    const revoked = { ...painting, commercialUse: false };
    await createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      assets: { ...deps.assets, findForWorkspace: vi.fn(async () => revoked) } as never,
    })(job);
    const [input] = motion.render.mock.calls[0] as unknown as [PlanInput];
    expect(input.plan.scenes[0]?.art).toBeUndefined();
    expect(input.plan.notes).toContain("background_fallback:1");
    expect(fetchSafeMedia).not.toHaveBeenCalled();
    expect(deps.renders.recordReady).toHaveBeenCalled();
  });

  const ambient: Asset = {
    ...source,
    id: "loop-1",
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 2_000,
    creator: "local:wan2.2-ti2v-5b",
    metadata: {
      role: "ambient_loop",
      backgroundAssetId: "bg-1",
      qa: { verdict: "pass" },
      generation: {
        model: "local:wan2.2-ti2v-5b",
        weightsLicense: "Apache-2.0",
        tool: "sd.cpp master-4a1b",
        seed: 7,
        prompt: "a home kitchen, static camera",
      },
    },
  };
  const loopDeps = (loopFrames: RenderLongFormDependencies["loopFrames"]) => {
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: paintedBoard() });
    const handler = createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      ...(loopFrames ? { loopFrames } : {}),
      assets: {
        ...deps.assets,
        findForWorkspace: vi.fn(async () => painting),
        listByMetadata: vi.fn(async () => [ambient]),
      } as never,
    });
    return { motion, deps, handler };
  };

  it("cycles an attached ambient loop under the scene and credits it as a source", async () => {
    vi.mocked(fetchSafeMedia)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1, 2]), mimeType: "image/png" } as never)
      .mockResolvedValueOnce({ bytes: new Uint8Array([9]), mimeType: "video/mp4" } as never);
    const loopFrames = vi.fn(async () => [new Uint8Array([1]), new Uint8Array([2])]);
    const { motion, deps, handler } = loopDeps(loopFrames);
    await handler(job);
    const [input] = motion.render.mock.calls[0] as unknown as [PlanInput];
    expect(input.plan.scenes[0]?.art).toEqual({
      href: "data:image/png;base64,AQI=",
      loop: { frames: ["data:image/jpeg;base64,AQ==", "data:image/jpeg;base64,Ag=="], fps: 30 },
    });
    expect(loopFrames).toHaveBeenCalledWith(new Uint8Array([9]), {});
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sourceAssetIds: ["bg-1", "loop-1"] }),
      }),
    );
  });

  it("keeps the approved still when the loop cannot be decoded", async () => {
    vi.mocked(fetchSafeMedia)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1, 2]), mimeType: "image/png" } as never)
      .mockResolvedValueOnce({ bytes: new Uint8Array([9]), mimeType: "video/mp4" } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { motion, deps, handler } = loopDeps(
      vi.fn(async () => {
        throw new Error("ambient_loop_unreadable");
      }),
    );
    await handler(job);
    const [input] = motion.render.mock.calls[0] as unknown as [PlanInput];
    expect(input.plan.scenes[0]?.art).toEqual({ href: "data:image/png;base64,AQI=" });
    expect(warn).toHaveBeenCalledWith(
      "fallback_used",
      expect.objectContaining({ reason: "ambient_loop_unavailable" }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("draws hand-drawn lines for a sketch_watercolor niche", async () => {
    const motion = motionRenderer();
    const { deps } = stickDeps({ board: motionBoard() });
    const sketchNiche = {
      ...mediaNiche(["alex", "sam"]),
      context: { characters: cast(["alex", "sam"]), explainer: { style: "sketch_watercolor" } },
    };
    await createRenderLongFormHandler({
      ...deps,
      motionRenderer: motion as never,
      niches: { findForWorkspace: vi.fn(async () => sketchNiche) } as never,
    })(job);
    const [input] = motion.render.mock.calls[0] as unknown as [{ plan: { lineStyle: string } }];
    expect(input.plan.lineStyle).toBe("sketch");
  });

  it("records settled zero-cost events for narration and render", async () => {
    const { deps, costEvents } = stickDeps();
    await createRenderLongFormHandler(deps)(job);
    expect(costEvents.map((event) => [event.provider, event.status])).toEqual([
      ["kokoro", "settled"],
      ["ffmpeg", "settled"],
    ]);
  });
});

describe("render_long_form handler for ai_clips storyboards", () => {
  const clipAsset = (id: string, over: Partial<Asset> = {}): Asset => ({
    id,
    workspaceId,
    objectKey: id,
    checksum: Buffer.from(id).toString("hex").padEnd(64, "0"),
    mimeType: "video/mp4",
    width: 0,
    height: 0,
    provenance: "generated",
    license: "internal",
    commercialUse: null,
    state: "active",
    metadata: { role: "stage_artifact", stage: "scene_clip" },
    ...over,
  });
  const clipBoard = (referenceAssetId?: string): Storyboard =>
    ({
      ...storyboard,
      renderer: "ai_clips",
      canvas: "portrait",
      scenes: [
        {
          index: 1,
          fromChar: 0,
          toChar: 5,
          clipPrompt: "A quiet kitchen at dawn",
          captionMode: "word",
          ...(referenceAssetId ? { referenceAssetId } : {}),
        },
        { index: 2, fromChar: 5, toChar: 11, clipPrompt: "A sunny park", captionMode: "line" },
      ],
    }) as unknown as Storyboard;
  const clipDeps = (
    over: {
      states?: Record<string, SceneClipState>;
      assets?: Record<string, Asset | null>;
      context?: Record<string, unknown> | null;
      board?: Storyboard;
    } = {},
  ) => {
    const assets: Record<string, Asset | null> = over.assets ?? {
      "clip-1": clipAsset("clip-1"),
      "clip-2": clipAsset("clip-2"),
      plate: { ...source, id: "plate", commercialUse: true },
    };
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([4, 5]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 10_000,
        })),
      } as never,
      speech: {
        synthesize: vi.fn(async ({ text }: { text: string }) => ({
          bytes: new Uint8Array([3]),
          mimeType: "audio/wav" as const,
          durationMs: 1000,
          words: text
            .split(/\s+/)
            .filter(Boolean)
            .map((word, index) => ({ text: word, startMs: index * 400, endMs: index * 400 + 350 })),
        })),
      },
      storyboards: { findForWorkspace: vi.fn(async () => over.board ?? clipBoard()) } as never,
      assets: {
        findForWorkspace: vi.fn(
          async ({ assetId }: { assetId: string }) => assets[assetId] ?? null,
        ),
        create: vi.fn(async (asset: Asset) => asset),
        updateState: vi.fn(async () => source),
      } as never,
      clipState: {
        read: vi.fn(
          async (): Promise<Record<string, SceneClipState>> =>
            over.states ?? {
              "1": { status: "ready", assetId: "clip-1", attempts: 1 },
              "2": { status: "ready", assetId: "clip-2", attempts: 1 },
            },
        ),
        write: vi.fn(),
      },
      content: {
        findContentItemForWorkspace: vi.fn(async () => ({ nicheId: "niche-1" })),
      } as never,
      niches: {
        findForWorkspace: vi.fn(async () => ({
          id: "niche-1",
          context: over.context === undefined ? null : over.context,
        })),
      } as never,
    });
    return deps;
  };
  const clipJob = job;
  const mp4 = () =>
    vi.mocked(fetchSafeMedia).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      mimeType: "video/mp4",
    });

  it("renders video slides from the stored clips, credits them as sources and stays unapprovable", async () => {
    mp4();
    const deps = clipDeps({ board: clipBoard("plate") });
    await createRenderLongFormHandler(deps)(clipJob);
    expect(deps.speech.synthesize).toHaveBeenCalledTimes(2);
    const input = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
    expect(input?.canvas).toBe("portrait");
    expect(input?.slides).toEqual([
      expect.objectContaining({ mimeType: "video/mp4", width: 768, height: 1152 }),
      expect.objectContaining({ mimeType: "video/mp4" }),
    ]);
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "rendered",
        commercialUse: null,
        metadata: expect.objectContaining({
          renderer: "ai_clips",
          sourceAssetIds: ["clip-1", "clip-2", "plate"],
        }),
      }),
    );
    expect(deps.renders.recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        timingManifest: expect.objectContaining({
          scenes: [
            expect.objectContaining({ sourceAssetId: "clip-1" }),
            expect.objectContaining({ sourceAssetId: "clip-2" }),
          ],
        }),
      }),
    );
  });
  it("downloads clips as video/mp4 only", async () => {
    mp4();
    vi.mocked(fetchSafeMedia).mockClear();
    const deps = clipDeps();
    await createRenderLongFormHandler(deps)(clipJob);
    expect(fetchSafeMedia).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetchSafeMedia).mock.calls)
      expect(call[1]).toMatchObject({ allowedMimeTypes: ["video/mp4"] });
  });
  it("resolves the niche caption theme (spec 2) for the clip render", async () => {
    mp4();
    const deps = clipDeps({ context: { captionTheme: { preset: "boxed" } } });
    await createRenderLongFormHandler(deps)(clipJob);
    const input = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
    expect(input?.captionStyle?.theme).toMatchObject({ canvas: "portrait" });
  });
  it("applies the niche video mark to the clip render", async () => {
    mp4();
    const deps = clipDeps({
      context: { videoMark: { enabled: true }, brandKit: { logoLightAssetId: "logo" } },
      assets: {
        "clip-1": clipAsset("clip-1"),
        "clip-2": clipAsset("clip-2"),
        logo: { ...source, id: "logo", commercialUse: true },
      },
    });
    await createRenderLongFormHandler(deps)(clipJob);
    expect(vi.mocked(deps.renderer.render).mock.calls[0]?.[0]?.mark).toBeDefined();
  });
  it("resolves the caption theme and video mark for a plain composed storyboard", async () => {
    mp4();
    const deps = clipDeps({
      board: storyboard,
      context: {
        captionTheme: { preset: "boxed" },
        videoMark: { enabled: true },
        brandKit: { logoLightAssetId: "scene-1" },
      },
      assets: { "scene-1": source },
    });
    await createRenderLongFormHandler(deps)(clipJob);
    const input = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
    expect(input?.captionStyle?.theme).toBeDefined();
    expect(input?.mark).toBeDefined();
  });
  it("uses the default captions when the niche has no theme", async () => {
    mp4();
    const deps = clipDeps();
    await createRenderLongFormHandler(deps)(clipJob);
    expect(vi.mocked(deps.renderer.render).mock.calls[0]?.[0]?.captionStyle).toBeUndefined();
  });
  it("fails naming the scene, before any narration, when a clip is not ready", async () => {
    const deps = clipDeps({
      states: {
        "1": { status: "ready", assetId: "clip-1", attempts: 1 },
        "2": { status: "submitted", attempts: 1 },
      },
    });
    await createRenderLongFormHandler(deps)({ ...clipJob, attemptCount: 2 });
    expect(deps.speech.synthesize).not.toHaveBeenCalled();
    expect(deps.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scene_clip_missing:2" }),
    );
  });
  it("fails when a clip asset is unusable (inactive, not video, other workspace)", async () => {
    const otherWorkspace = parseWorkspaceId("99999999-9999-4999-8999-999999999999");
    for (const bad of [
      clipAsset("clip-2", { state: "pending" }),
      clipAsset("clip-2", { mimeType: "image/png" }),
      clipAsset("clip-2", { workspaceId: otherWorkspace }),
      null,
    ]) {
      const deps = clipDeps({ assets: { "clip-1": clipAsset("clip-1"), "clip-2": bad } });
      await createRenderLongFormHandler(deps)({ ...clipJob, attemptCount: 2 });
      expect(deps.speech.synthesize).not.toHaveBeenCalled();
      expect(deps.renders.recordFailed).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "scene_clip_missing:2" }),
      );
    }
  });
  it("fails when the worker has no clip state repository", async () => {
    const deps = clipDeps();
    const bare = { ...deps, clipState: undefined } as unknown as RenderLongFormDependencies;
    await createRenderLongFormHandler(bare)({ ...clipJob, attemptCount: 2 });
    expect(bare.renders.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scene_clips_unavailable" }),
    );
  });
  describe("fallback_static scenes", () => {
    const plate = (): Asset => ({
      ...source,
      id: "plate",
      provenance: "generated",
      metadata: { role: "scene" },
    });
    const boardWithPlates = (): Storyboard => {
      const base = clipBoard("plate") as unknown as { scenes: object[] };
      return {
        ...base,
        scenes: base.scenes.map((scene) => ({ ...scene, referenceAssetId: "plate" })),
      } as unknown as Storyboard;
    };
    const fallbackStates = {
      "1": { status: "ready", assetId: "clip-1", attempts: 1 },
      "2": { status: "fallback_static", attempts: 2 },
    } as Record<string, SceneClipState>;

    it("renders the owned reference plate as a zoom clip and reports scene_clip_fallback", async () => {
      vi.mocked(fetchSafeMedia).mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        mimeType: "video/mp4",
      });
      const base = clipDeps({
        board: boardWithPlates(),
        states: fallbackStates,
        assets: { "clip-1": clipAsset("clip-1"), plate: plate() },
      });
      const staticClip = vi.fn(async () => new Uint8Array([7, 7, 7]));
      vi.mocked(base.renderer.render).mockResolvedValueOnce({
        bytes: new Uint8Array([4, 5]),
        mimeType: "video/mp4" as const,
        width: 1080,
        height: 1920,
        durationMs: 10_000,
        quality: { version: 1, verdict: "pass", checks: [], measuredAt: "2026-10-02T00:00:00Z" },
      } as never);
      await createRenderLongFormHandler({ ...base, staticClip })(clipJob);
      expect(staticClip).toHaveBeenCalledWith(
        expect.objectContaining({ width: 720, height: 1280, seconds: expect.any(Number) }),
      );
      const input = vi.mocked(base.renderer.render).mock.calls[0]?.[0];
      expect(input?.slides[1]).toMatchObject({
        mimeType: "video/mp4",
        bytes: new Uint8Array([7, 7, 7]),
      });
      expect(base.renders.recordReady).toHaveBeenCalledWith(
        expect.objectContaining({
          qualityReport: expect.objectContaining({
            visual: expect.objectContaining({
              findings: [
                expect.objectContaining({
                  id: "scene_clip_fallback:2",
                  severity: "WARN",
                  sceneIndex: 2,
                }),
              ],
            }),
          }),
        }),
      );
    });
    it("fails closed when the fallback plate is not an owned reference", async () => {
      const base = clipDeps({
        board: boardWithPlates(),
        states: fallbackStates,
        assets: {
          "clip-1": clipAsset("clip-1"),
          plate: { ...plate(), metadata: { role: "listing_image" } },
        },
      });
      const staticClip = vi.fn(async () => new Uint8Array([7]));
      await createRenderLongFormHandler({ ...base, staticClip })({ ...clipJob, attemptCount: 2 });
      expect(staticClip).not.toHaveBeenCalled();
      expect(base.renders.recordFailed).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "scene_clip_missing:2" }),
      );
    });
  });
});
