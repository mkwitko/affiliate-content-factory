import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../assets/asset.js";
import type { Channel } from "../channels/channel.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import type { Niche } from "../niches/niche.js";
import type { Offer } from "../offers/offer.js";
import { type FidelityMetrics, PROVISIONAL_FIDELITY_THRESHOLDS } from "./product-fidelity.js";
import type { RenderCreativesDeps, RenderCreativesInput } from "./render-creatives.js";
import { renderCreatives } from "./render-creatives.js";

const workspaceId = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const source: Asset = {
  id: "photo",
  workspaceId,
  objectKey: "photo",
  checksum: "photo",
  mimeType: "image/jpeg",
  width: 1200,
  height: 1200,
  provenance: "provider_import",
  commercialUse: null,
  license: "Mercado Livre listing photo",
  state: "active",
};
const item: ContentItem = {
  id: "item",
  workspaceId,
  nicheId: "niche",
  offerId: "offer",
  offerSnapshotId: "snapshot",
  title: "Support",
  sourceFactKeys: [],
  sourcePictureAssetIds: ["photo"],
  creativeOpinion: "A useful stand",
  state: "draft",
};
const offer: Offer = {
  id: "offer",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB777",
  title: "Support",
  state: "active",
  snapshots: [],
  activeSnapshotId: "snapshot",
};
const niche: Niche = {
  id: "niche",
  workspaceId,
  name: "Home office",
  audience: "Workers",
  problem: "Poor posture",
  editorialVoice: "Direct",
  languages: ["pt-BR"],
  monetizationHypothesis: "Affiliate",
  state: "active",
  kind: "affiliate",
};
const channel = (
  id: string,
  kind: Channel["kind"],
  canvas: "feed" | "story",
): Channel & { canvas: "feed" | "story" } => ({
  id,
  workspaceId,
  kind,
  canvas,
  connectionId: "connection",
  label: id,
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
  },
});
const feed = channel("feed", "instagram_carousel", "feed");
const stories = channel("stories", "instagram_stories", "story");
const threads = channel("threads-1", "threads", "feed");
const variant = (channelId: string): ContentVariant => ({
  id: `variant-${channelId}`,
  workspaceId,
  contentItemId: item.id,
  channelId,
  offerSnapshotId: "snapshot",
  assetIds: [],
  caption: "Caption",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
});
const slides = ["hero", "benefit", "benefit", "proof", "price", "cta"].map((template, index) => ({
  index: index + 1,
  total: 6,
  template: template as "hero" | "benefit" | "proof" | "price" | "cta",
  headline: `Headline ${index + 1}`,
  claims: [],
}));
const input: RenderCreativesInput = {
  workspaceId,
  contentItemId: item.id,
  slides,
  channels: [
    { channelId: feed.id, kind: feed.kind, canvas: "feed" },
    { channelId: stories.id, kind: stories.kind, canvas: "story" },
  ],
};
const makeDeps = (): RenderCreativesDeps => {
  const stored: Asset[] = [
    source,
    { ...source, id: "canonical", license: "Derived from Mercado Livre listing photo (framed)" },
  ];
  const variants = [variant(feed.id), variant(stories.id)];
  return {
    content: {
      findContentItemForWorkspace: vi.fn(async () => item),
      listVariantsForWorkspace: vi.fn(async () => variants),
      updateVariant: vi.fn(async (next) => next),
    },
    offers: { findForWorkspace: vi.fn(async () => offer) },
    niches: { findForWorkspace: vi.fn(async () => niche) },
    workspaces: { getContext: vi.fn(async () => ({})) },
    channels: {
      findForWorkspace: vi.fn(async ({ channelId }) =>
        channelId === feed.id ? feed : channelId === threads.id ? threads : stories,
      ),
    },
    assets: {
      findForWorkspace: vi.fn(
        async ({ assetId }) => stored.find((asset) => asset.id === assetId) ?? null,
      ),
      listByMetadata: vi.fn(async () => []),
      create: vi.fn(async (asset) => {
        stored.push(asset);
        return asset;
      }),
      updateState: vi.fn(async ({ assetId, state }) => {
        const current = stored.find((asset) => asset.id === assetId);
        if (!current) return null;
        const active = { ...current, state };
        stored[stored.indexOf(current)] = active;
        return active;
      }),
    },
    store: {
      createDownload: vi.fn(async ({ assetId }) => ({
        method: "GET" as const,
        url: `https://assets.test/${assetId}`,
      })),
      putObject: vi.fn(async () => undefined),
    },
    fetchBytes: vi.fn(async () => new Uint8Array([7, 8, 9])),
    canonical: vi.fn(async () => ({
      assetId: "canonical",
      mode: "framed" as const,
      sourceAssetId: "photo",
      width: 1200,
      height: 1200,
    })),
    scenes: vi.fn(async () => ({ procedural: true as const })),
    renderer: {
      render: vi.fn(async ({ canvas, spec }) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/jpeg" as const,
        width: 1080,
        height: canvas === "feed" ? 1350 : 1920,
        layout: { headlineFontSize: 92, bodyDropped: false },
        spec,
      })),
    },
    now: () => new Date("2026-09-25T12:00:00Z"),
  };
};

describe("renderCreatives", () => {
  it("renders all slides for every channel from one canonical product and one scene per role", async () => {
    const deps = makeDeps();
    const out = await renderCreatives(deps, input);
    expect(out.status).toBe("rendered");
    expect(deps.canonical).toHaveBeenCalledOnce();
    expect(deps.scenes).toHaveBeenCalledTimes(2);
    expect(deps.renderer.render).toHaveBeenCalledTimes(12);
    expect(out.status === "rendered" && out.assetIdsByChannel.feed).toHaveLength(6);
  });
  it("gives a threads variant only the cover slide", async () => {
    const deps = makeDeps();
    const threadsVariant = variant(threads.id);
    (deps.content.listVariantsForWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([
      variant(feed.id),
      variant(stories.id),
      threadsVariant,
    ]);
    const out = await renderCreatives(deps, {
      ...input,
      channels: [...input.channels, { channelId: threads.id, kind: "threads", canvas: "feed" }],
    });
    expect(out.status).toBe("rendered");
    expect(out.status === "rendered" && out.assetIdsByChannel[threads.id]).toHaveLength(1);
  });
  it("uses procedural backgrounds and reports the fallback", async () => {
    const out = await renderCreatives(makeDeps(), input);
    expect(out.status).toBe("rendered");
    if (out.status === "rendered") expect(out.fallbacks).toContain("scene:procedural");
  });
  it("classifies missing source photos as content failure", async () => {
    const deps = makeDeps();
    vi.mocked(deps.canonical).mockRejectedValue(new Error("no_source_picture"));
    expect(await renderCreatives(deps, input)).toEqual({
      status: "content_failure",
      reason: "no_source_picture",
    });
  });
  it("returns renderer failure before storing assets when composition fails", async () => {
    const deps = makeDeps();
    vi.mocked(deps.renderer.render).mockRejectedValue(new Error("layout_failed:headline_unfit"));
    expect(await renderCreatives(deps, input)).toEqual({
      status: "renderer_failure",
      reason: "layout_failed:headline_unfit",
    });
    expect(deps.assets.create).not.toHaveBeenCalled();
  });
  it("adds the channel disclosure to CTA slides", async () => {
    const deps = makeDeps();
    await renderCreatives(deps, input);
    const calls = vi.mocked(deps.renderer.render).mock.calls;
    const ctaCalls = calls.filter(([entry]) => entry.spec.template === "cta");
    expect(
      ctaCalls.every(
        ([entry]) =>
          entry.spec.disclosure === "Link de afiliado" ||
          entry.spec.disclosure === "#publi · link de afiliado",
      ),
    ).toBe(true);
  });

  it("stores the worst product fidelity verdict per variant with one report per slide", async () => {
    const deps = makeDeps();
    const good: FidelityMetrics = {
      maskIou: 0.99,
      deltaE: 0.5,
      msSsim: 0.99,
      edgeRecall: 0.99,
      edgeExcess: 0,
      inventedText: [],
    };
    const measure = vi.fn(async (): Promise<FidelityMetrics> => good);
    measure.mockResolvedValueOnce({ ...good, maskIou: 0.4 });
    const region = { x: 1, y: 2, w: 3, h: 4 };
    const renderer = {
      render: vi.fn(async ({ canvas }: { canvas: "feed" | "story" }) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/jpeg" as const,
        width: 1080,
        height: canvas === "feed" ? 1350 : 1920,
        layout: { headlineFontSize: 92, bodyDropped: false },
        product: { layer: new Uint8Array([4]), region },
      })),
    };
    const out = await renderCreatives(
      {
        ...deps,
        renderer,
        fidelity: { measurer: { measure }, thresholds: PROVISIONAL_FIDELITY_THRESHOLDS },
      },
      input,
    );
    expect(out.status).toBe("rendered");
    expect(measure).toHaveBeenCalledTimes(12);
    expect(measure).toHaveBeenCalledWith({
      original: new Uint8Array([4]),
      rendered: new Uint8Array([1, 2, 3]),
      region,
    });
    const [feedUpdate, storiesUpdate] = (
      deps.content.updateVariant as ReturnType<typeof vi.fn>
    ).mock.calls.map(([next]) => next as ContentVariant);
    expect(feedUpdate?.creativeRender?.fidelity?.verdict).toBe("block");
    expect(feedUpdate?.creativeRender?.fidelity?.slides).toHaveLength(6);
    expect(feedUpdate?.creativeRender?.fidelity?.slides[0]).toMatchObject({
      slideIndex: 1,
      verdict: "block",
      reasons: ["maskIou_block"],
      thresholdSet: "provisional-2026-09-30",
    });
    expect(storiesUpdate?.creativeRender?.fidelity?.verdict).toBe("pass");
  });

  it("routes slides to review when the product layer is missing or measuring fails", async () => {
    const missing = makeDeps();
    const unused = vi.fn(async (): Promise<FidelityMetrics> => {
      throw new Error("not called");
    });
    await renderCreatives(
      {
        ...missing,
        fidelity: { measurer: { measure: unused }, thresholds: PROVISIONAL_FIDELITY_THRESHOLDS },
      },
      input,
    );
    expect(unused).not.toHaveBeenCalled();
    const [first] = (missing.content.updateVariant as ReturnType<typeof vi.fn>).mock.calls.map(
      ([next]) => next as ContentVariant,
    );
    expect(first?.creativeRender?.fidelity?.verdict).toBe("warn");
    expect(first?.creativeRender?.fidelity?.slides[0]?.reasons).toContain("maskIou_unmeasured");

    const failing = makeDeps();
    const broken = vi.fn(async (): Promise<FidelityMetrics> => {
      throw new Error("fidelity_region_invalid");
    });
    const renderer = {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "image/jpeg" as const,
        width: 1080,
        height: 1350,
        layout: { headlineFontSize: 92, bodyDropped: false },
        product: { layer: new Uint8Array([4]), region: { x: 0, y: 0, w: 1, h: 1 } },
      })),
    };
    const out = await renderCreatives(
      {
        ...failing,
        renderer,
        fidelity: { measurer: { measure: broken }, thresholds: PROVISIONAL_FIDELITY_THRESHOLDS },
      },
      input,
    );
    expect(out.status).toBe("rendered");
    const [update] = (failing.content.updateVariant as ReturnType<typeof vi.fn>).mock.calls.map(
      ([next]) => next as ContentVariant,
    );
    expect(update?.creativeRender?.fidelity?.verdict).toBe("warn");
  });

  it("stores no fidelity report when fidelity QA is not configured", async () => {
    const deps = makeDeps();
    await renderCreatives(deps, input);
    const [first] = (deps.content.updateVariant as ReturnType<typeof vi.fn>).mock.calls.map(
      ([next]) => next as ContentVariant,
    );
    expect(first?.creativeRender).toBeDefined();
    expect(first?.creativeRender?.fidelity).toBeUndefined();
  });

  it("fills document-derived features after render without overwriting operator ones", async () => {
    const deps = makeDeps();
    const variants = await deps.content.listVariantsForWorkspace(workspaceId);
    const feedVariant = variants[0] as ContentVariant;
    vi.mocked(deps.content.listVariantsForWorkspace).mockResolvedValue([
      {
        ...feedVariant,
        creativeFeatures: {
          hookMove: "bold_claim",
          priceShown: true,
          discountShown: false,
          ratingShown: false,
        },
      },
      ...variants.slice(1),
    ]);
    await renderCreatives(deps, input);
    const updates = vi.mocked(deps.content.updateVariant).mock.calls.map(([next]) => next);
    expect(updates[0]?.creativeFeatures).toMatchObject({
      hookMove: "bold_claim",
      priceShown: true,
      layoutFamily: "product_cutout",
      productMode: "framed",
    });
    expect(updates[1]?.creativeFeatures).toMatchObject({ layoutFamily: "product_cutout" });
  });

  it("persists a creative document with every rendered slide", async () => {
    const deps = makeDeps();
    await renderCreatives(deps, input);
    const created = vi.mocked(deps.assets.create).mock.calls.map(([asset]) => asset);
    expect(created).toHaveLength(12);
    const doc = created[0]?.metadata?.creativeDocument as Record<string, unknown>;
    expect(doc).toMatchObject({
      version: 1,
      rendererVersion: 1,
      preset: "instagram_feed",
      layoutFamily: "product_cutout",
      layers: { product: { mode: "framed", assetId: "canonical" } },
      copy: { index: 1, headline: "Headline 1" },
    });
    expect(doc.brandKitHash).toBe(created[0]?.metadata?.brandKitHash);
    expect(created[6]?.metadata?.creativeDocument).toMatchObject({ preset: "instagram_story" });
  });

  describe("scene pinning", () => {
    const pinnedAsset = (state: "active" | "archived"): Asset => ({
      ...source,
      id: "scene-pinned",
      checksum: "scene-ck",
      license: "scene",
      state,
    });
    const withPinned = (state: "active" | "archived"): RenderCreativesDeps => {
      const deps = makeDeps();
      const find = deps.assets.findForWorkspace;
      return {
        ...deps,
        assets: {
          ...deps.assets,
          findForWorkspace: vi.fn(async (args) =>
            args.assetId === "scene-pinned" ? pinnedAsset(state) : find(args),
          ),
          listByMetadata: vi.fn(async ({ key }) =>
            key === "contentItemId"
              ? [
                  {
                    ...source,
                    id: "old-render",
                    metadata: {
                      slideIndex: 1,
                      creativeDocument: { layers: { scene: { assetId: "scene-pinned" } } },
                    },
                  },
                ]
              : [],
          ),
        },
      };
    };
    it("reuses the previously pinned scene for the same slide instead of picking again", async () => {
      const deps = withPinned("active");
      await renderCreatives(deps, input);
      // Slide 1 keeps its pinned scene; the unpinned cta slide still picks a hero scene.
      expect(deps.scenes).toHaveBeenCalledTimes(2);
      const first = vi.mocked(deps.assets.create).mock.calls[0]?.[0];
      expect(first?.metadata?.sceneAssetId).toBe("scene-pinned");
      expect(first?.metadata?.creativeDocument).toMatchObject({
        layers: { scene: { assetId: "scene-pinned", checksum: "scene-ck" } },
      });
    });
    it("picks again when the pinned scene is no longer active", async () => {
      const deps = withPinned("archived");
      await renderCreatives(deps, input);
      expect(vi.mocked(deps.assets.create).mock.calls[0]?.[0].metadata?.sceneAssetId).toBeNull();
    });
  });

  describe("in-scene slides", () => {
    const sceneId = "11111111-2222-4333-8444-555555555555";
    const scene = (patch: Partial<Asset> = {}): Asset => ({
      ...source,
      id: sceneId,
      checksum: "scene-ck",
      mimeType: "image/png",
      provenance: "generated",
      license: "local scene",
      commercialUse: true,
      ...patch,
    });
    const money = (amountMinor: number) => ({ amountMinor, currency: "BRL" });
    const fact = (key: string, value: unknown, verified = true) => ({
      key,
      value: value as never,
      sourceUrl: "https://x.test",
      verified,
    });
    const sceneSlides = slides.map((slide, i) => ({
      ...slide,
      sceneAssetId: sceneId,
      ...(i === 0 ? { badge: "De R$ 1,00 por R$ 0,50" } : {}),
    }));
    const inSceneDeps = (asset: Asset | null = scene()) => {
      const deps = makeDeps();
      const find = deps.assets.findForWorkspace;
      return {
        ...deps,
        offers: {
          findForWorkspace: vi.fn(async () => ({
            ...offer,
            snapshots: [
              {
                id: "snapshot",
                verifiedAt: new Date("2026-10-01T10:00:00Z"),
                facts: [fact("current_price", money(3685)), fact("list_price", money(4990))],
              },
            ],
          })),
        },
        assets: {
          ...deps.assets,
          findForWorkspace: vi.fn(async (args: { assetId: string }) =>
            args.assetId === sceneId ? asset : find(args as never),
          ),
        },
      } as RenderCreativesDeps;
    };
    const run = (deps: RenderCreativesDeps) =>
      renderCreatives(deps, { ...input, slides: sceneSlides });

    it("renders the scene with the preset CTA, disclosure and price from facts, without a cutout", async () => {
      const deps = inSceneDeps();
      const out = await run(deps);
      expect(out.status).toBe("rendered");
      expect(deps.canonical).not.toHaveBeenCalled();
      expect(deps.scenes).not.toHaveBeenCalled();
      const calls = vi.mocked(deps.renderer.render).mock.calls.map(([entry]) => entry);
      expect(calls).toHaveLength(12);
      expect(calls.every((entry) => "inScene" in entry.product)).toBe(true);
      expect(calls.every((entry) => entry.spec.disclosure === "#publi")).toBe(true);
      const feedFirst = calls[0];
      expect(feedFirst?.preset).toBe("instagram_feed");
      expect(feedFirst?.price?.original).toEqual(money(4990));
      expect(feedFirst?.price?.discountPct).toBe(26);
      expect(feedFirst?.cta).toBeUndefined();
      expect(calls[1]?.price).toBeUndefined();
      expect(calls[5]?.cta).toBe("Link na bio");
      const doc = vi.mocked(deps.assets.create).mock.calls[5]?.[0].metadata?.creativeDocument;
      expect(doc).toMatchObject({
        layoutFamily: "character_product",
        layers: {
          scene: { assetId: sceneId, checksum: "scene-ck" },
          product: { mode: "in_scene" },
        },
        cta: { kind: "link_in_bio" },
      });
    });
    it("draws the story cover from its own 9:16 scene and the other story slides from the feed scene", async () => {
      const storyId = "11111111-2222-4333-8444-666666666666";
      const deps = inSceneDeps();
      const find = deps.assets.findForWorkspace;
      const withStory = {
        ...deps,
        assets: {
          ...deps.assets,
          findForWorkspace: vi.fn(async (args: { assetId: string }) =>
            args.assetId === storyId ? scene({ id: storyId }) : find(args as never),
          ),
        },
      } as RenderCreativesDeps;
      const out = await renderCreatives(withStory, {
        ...input,
        slides: sceneSlides.map((slide, i) =>
          i === 0 ? { ...slide, storySceneAssetId: storyId } : slide,
        ),
      });
      expect(out.status).toBe("rendered");
      const ids = vi
        .mocked(withStory.assets.create)
        .mock.calls.map(([asset]) => asset.metadata?.sceneAssetId);
      expect(ids[0]).toBe(sceneId);
      expect(ids[6]).toBe(storyId);
      expect(ids[7]).toBe(sceneId);
    });
    it("keeps the carousel's text layer as a slide_overlay asset for 2.5D Reels, not the story's", async () => {
      const deps = inSceneDeps();
      const render = deps.renderer.render as ReturnType<typeof vi.fn>;
      const base = render.getMockImplementation() as (...args: unknown[]) => Promise<object>;
      render.mockImplementation(async (...args: unknown[]) => ({
        ...(await base(...args)),
        overlay: new Uint8Array([9, 9]),
      }));
      expect((await run(deps)).status).toBe("rendered");
      const created = vi.mocked(deps.assets.create).mock.calls.map(([asset]) => asset);
      const overlays = created.filter((asset) => asset.metadata?.role === "slide_overlay");
      expect(overlays).toHaveLength(6);
      expect(overlays[0]).toMatchObject({ mimeType: "image/png", width: 1080, height: 1350 });
      const slidesWithOverlay = created.filter((asset) => asset.metadata?.overlayAssetId);
      expect(slidesWithOverlay.map((asset) => asset.metadata?.overlayAssetId)).toEqual(
        overlays.map((asset) => asset.id),
      );
      expect(slidesWithOverlay.every((asset) => asset.height === 1350)).toBe(true);
    });
    const withBoxes = (deps: RenderCreativesDeps, boxes: object) => {
      const render = deps.renderer.render as ReturnType<typeof vi.fn>;
      const base = render.getMockImplementation() as (...args: unknown[]) => Promise<object>;
      render.mockImplementation(async (...args: unknown[]) => ({
        ...(await base(...args)),
        layout: { headlineFontSize: 92, bodyDropped: false, boxes },
      }));
    };
    it("stores a quality report per in-scene slide and a worst verdict on the variant", async () => {
      const deps = inSceneDeps();
      withBoxes(deps, { headline: { x: 100, y: 100, w: 600, h: 200 } });
      const measureContrast = vi.fn(async () => 7);
      expect((await run({ ...deps, quality: { measureContrast } })).status).toBe("rendered");
      const doc = vi.mocked(deps.assets.create).mock.calls[0]?.[0].metadata?.creativeDocument as {
        quality?: { verdict: string; score: number };
      };
      expect(doc.quality).toMatchObject({ verdict: "pass", score: 100 });
      const [first] = vi.mocked(deps.content.updateVariant).mock.calls.map(([v]) => v);
      // Every slide passes on its own; the fixture draws one scene for all six, which the
      // sequence QA (brief 14) blocks as a repeated scene and folds into the variant verdict.
      expect(first?.creativeRender?.quality).toMatchObject({
        verdict: "block",
        sequence: { verdict: "block" },
      });
      expect(first?.creativeRender?.quality?.sequence?.reasons[0]).toBe("duplicate_scene:1,2");
      expect(first?.creativeRender?.quality?.slides).toHaveLength(6);
      expect(first?.creativeRender?.quality?.slides.every((s) => s.verdict === "pass")).toBe(true);
      expect(measureContrast).toHaveBeenCalled();
    });
    it("blocks the variant when a slide has text outside the canvas", async () => {
      const deps = inSceneDeps();
      withBoxes(deps, { headline: { x: 1000, y: 100, w: 600, h: 200 } });
      await run(deps);
      const [first] = vi.mocked(deps.content.updateVariant).mock.calls.map(([v]) => v);
      expect(first?.creativeRender?.quality?.verdict).toBe("block");
    });
    it("marks every in-scene variant for human review", async () => {
      const deps = inSceneDeps();
      await run(deps);
      const [first] = vi.mocked(deps.content.updateVariant).mock.calls.map(([v]) => v);
      expect(first?.creativeRender?.fidelity?.verdict).toBe("warn");
      expect(first?.creativeRender?.fidelity?.slides[0]?.reasons).toEqual(["in_scene_unverified"]);
    });
    it("passes the scene's stored subject boxes and records the overlay layout", async () => {
      const face = { kind: "face", box: [300, 100, 700, 300] } as const;
      const deps = inSceneDeps(
        scene({ metadata: { inSceneFidelity: { vlm: { subjects: [face] } } } }),
      );
      const subjectLayout = {
        top: {
          placement: "bottom",
          scale: 1,
          width: 952,
          card: false,
          box: { x: 64, y: 700, w: 900, h: 300 },
        },
        bottom: {
          placement: "bottom",
          scale: 1,
          width: 952,
          card: false,
          box: { x: 64, y: 1010, w: 952, h: 260 },
        },
        collisions: [],
      };
      const headline = { x: 64, y: 760, w: 900, h: 240 };
      vi.mocked(deps.renderer.render).mockImplementation(
        async ({ canvas }) =>
          ({
            bytes: new Uint8Array([1]),
            mimeType: "image/jpeg",
            width: 1080,
            height: canvas === "story" ? 1920 : 1350,
            layout: {
              headlineFontSize: 92,
              bodyDropped: false,
              boxes: { headline },
              subjectLayout,
            },
          }) as never,
      );
      await run(deps);
      const [call] = vi.mocked(deps.renderer.render).mock.calls.map(([entry]) => entry);
      expect(call?.subjects).toEqual([face]);
      const doc = vi.mocked(deps.assets.create).mock.calls[0]?.[0].metadata?.creativeDocument;
      expect(doc).toMatchObject({ boxes: { headline }, subjectLayout });
    });
    describe("stored in-scene fidelity result", () => {
      const vlm = {
        productPresent: true,
        sameProductAsReference: true,
        counts: {},
        inventedTextOrLogo: false,
        notes: "",
      };
      const colour = [{ productShare: 0.9, scenePresence: 0.1 }];
      const verdictFor = async (inSceneFidelity: unknown) => {
        const deps = inSceneDeps(scene({ metadata: { inSceneFidelity } }));
        await run(deps);
        const [first] = vi.mocked(deps.content.updateVariant).mock.calls.map(([v]) => v);
        return first?.creativeRender?.fidelity?.slides[0];
      };
      it("passes when the VLM and colour checks agree", async () => {
        expect(await verdictFor({ vlm, colour })).toMatchObject({ verdict: "pass", reasons: [] });
      });
      it("blocks when the VLM says the product differs", async () => {
        expect(
          await verdictFor({ vlm: { ...vlm, sameProductAsReference: false }, colour }),
        ).toMatchObject({ verdict: "block", reasons: ["product_differs_from_reference"] });
      });
      it("keeps warn without a colour check or with a malformed result", async () => {
        expect(await verdictFor({ vlm })).toMatchObject({ verdict: "warn" });
        expect(await verdictFor({ vlm: { productPresent: true } })).toMatchObject({
          verdict: "warn",
          reasons: ["in_scene_unverified"],
        });
      });
    });
    it("refuses unavailable or unlicensed scene assets", async () => {
      expect(await run(inSceneDeps(null))).toEqual({
        status: "content_failure",
        reason: "scene_asset_unavailable",
      });
      expect(await run(inSceneDeps(scene({ state: "pending_review" })))).toMatchObject({
        reason: "scene_asset_unavailable",
      });
      expect(await run(inSceneDeps(scene({ mimeType: "video/mp4" })))).toMatchObject({
        reason: "scene_asset_unavailable",
      });
      expect(await run(inSceneDeps(scene({ commercialUse: null })))).toEqual({
        status: "content_failure",
        reason: "scene_asset_rights_unverified",
      });
    });
    it("draws the copy badge when no verified price exists", async () => {
      const deps = inSceneDeps();
      vi.mocked(deps.offers.findForWorkspace).mockResolvedValue({ ...offer, snapshots: [] });
      await run(deps);
      expect(vi.mocked(deps.renderer.render).mock.calls[0]?.[0].price).toBeUndefined();
    });
  });
});
