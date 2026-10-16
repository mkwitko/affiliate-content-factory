import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { type Asset, createAsset } from "../assets/asset.js";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import { type BrandKitOverride, brandKitHash, mergeBrandKit } from "../brand/brand-kit.js";
import type { ChannelKind } from "../channels/channel.js";
import type { ChannelRepository } from "../channels/channel-repository.js";
import type { ContentVariant } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import { productIdFromOffer } from "../offers/offer.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import type { WorkspaceRepository } from "../workspaces/workspace-repository.js";
import type { CanonicalProduct } from "./canonical-product.js";
import { type CreativeDocument, pinnedSceneId } from "./creative-document.js";
import type { CreativeRenderer, RenderedSlide } from "./creative-renderer.js";
import { RENDERER_VERSION } from "./creative-renderer.js";
import { deriveCreativeFeatures } from "./derive-creative-features.js";
import { disclosurePolicy } from "./disclosure.js";
import {
  judgeInSceneFidelity,
  parseStoredInSceneFidelity,
  productVisualSpecFor,
  type SubjectBox,
  storedSubjectBoxes,
} from "./in-scene-fidelity.js";
import {
  CTA_TEXT,
  pillLabelColour,
  presetForCanvas,
  presetForChannelKind,
} from "./platform-presets.js";
import { priceDisplayFromFacts } from "./price-display.js";
import {
  type FidelityMeasurer,
  type FidelityMetrics,
  type FidelityReport,
  type FidelityThresholds,
  judgeFidelity,
  UNMEASURED_FIDELITY,
  worstFidelityVerdict,
} from "./product-fidelity.js";
import type { PickedScene } from "./scene-bank.js";
import type { ScenePlan } from "./scene-plan.js";
import { judgeCarouselSequence } from "./sequence-quality.js";
import {
  type ContrastMeasurer,
  judgeSlideQuality,
  type QualityVerdict,
  worstQualityVerdict,
} from "./slide-quality.js";
import type { SlideSpec } from "./slide-spec.js";
import { validateSlideSpec } from "./slide-spec.js";
import { type CanvasKind, templateFor } from "./templates.js";

export type RenderCreativesInput = Readonly<{
  workspaceId: WorkspaceId;
  contentItemId: string;
  slides: readonly SlideSpec[];
  channels: readonly { channelId: string; kind: ChannelKind; canvas: CanvasKind }[];
}>;
export type RenderCreativesDeps = Readonly<{
  content: Pick<
    ContentRepository,
    "findContentItemForWorkspace" | "listVariantsForWorkspace" | "updateVariant"
  >;
  offers: Pick<OfferRepository, "findForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
  workspaces: { getContext: NonNullable<WorkspaceRepository["getContext"]> };
  channels: Pick<ChannelRepository, "findForWorkspace">;
  assets: Pick<AssetRepository, "findForWorkspace" | "create" | "updateState"> & {
    listByMetadata: NonNullable<AssetRepository["listByMetadata"]>;
  };
  store: Pick<AssetStore, "putObject" | "createDownload">;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  canonical: (input: {
    workspaceId: WorkspaceId;
    productId: string;
    sourceAssets: readonly Asset[];
  }) => Promise<CanonicalProduct>;
  scenes: (input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    plan: ScenePlan;
    recentSceneIds: readonly string[];
    correlationId?: string;
  }) => Promise<PickedScene>;
  renderer: CreativeRenderer;
  /** Product fidelity QA; absent keeps today's behaviour (no report on the variant). */
  fidelity?: Readonly<{ measurer: FidelityMeasurer; thresholds: FidelityThresholds }>;
  /** Legibility QA: contrast is measured on the pixels by a provider; absent skips only that check. */
  quality?: Readonly<{ measureContrast: ContrastMeasurer }>;
  now: () => Date;
}>;
export type RenderCreativesOutcome = Readonly<
  | { status: "rendered"; assetIdsByChannel: Record<string, string[]>; fallbacks: string[] }
  | { status: "content_failure" | "renderer_failure"; reason: string }
>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const roleFor = (slide: SlideSpec): "hero" | "secondary" =>
  slide.index === 1 || slide.template === "cta" ? "hero" : "secondary";
const scenePlanFor = (input: {
  role: "hero" | "secondary";
  template: ReturnType<typeof templateFor>;
  nicheSetting: string;
  paletteHint: string;
}): ScenePlan => ({
  role: input.role,
  productAnchor: input.template.productAnchor,
  surface: input.role === "hero" ? "table" : "shelf",
  lighting: "top-left",
  nicheSetting: input.nicheSetting,
  paletteHint: input.paletteHint,
});
const failure = (error: unknown): string =>
  error instanceof Error ? error.message : "creative_render_failed";
const missingContent = (reason: string): RenderCreativesOutcome => ({
  status: "content_failure",
  reason,
});
const failedRender = (error: unknown): RenderCreativesOutcome => ({
  status: "renderer_failure",
  reason: failure(error),
});

export const renderCreatives = async (
  deps: RenderCreativesDeps,
  input: RenderCreativesInput,
): Promise<RenderCreativesOutcome> => {
  if (input.slides.length === 0 || input.channels.length === 0)
    return missingContent("render_input_empty");
  const invalid = input.slides.map(validateSlideSpec).find((verdict) => !verdict.ok);
  if (invalid && !invalid.ok) return missingContent(invalid.reason);
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId: input.workspaceId,
    contentItemId: input.contentItemId,
  });
  if (!item) return missingContent("content_not_found");
  const [offer, niche, workspaceContext, variants, foundPictures] = await Promise.all([
    item.offerId
      ? deps.offers.findForWorkspace({ workspaceId: input.workspaceId, offerId: item.offerId })
      : Promise.resolve(null),
    deps.niches.findForWorkspace({ workspaceId: input.workspaceId, nicheId: item.nicheId }),
    deps.workspaces.getContext(input.workspaceId),
    deps.content.listVariantsForWorkspace(input.workspaceId),
    Promise.all(
      (item.sourcePictureAssetIds ?? []).map((assetId) =>
        deps.assets.findForWorkspace({ workspaceId: input.workspaceId, assetId }),
      ),
    ),
  ]);
  if (!offer || offer.state !== "active") return missingContent("offer_not_active");
  if (!niche) return missingContent("niche_not_found");
  // Slides that carry a `sceneAssetId` are in-scene (the product is painted into the scene) and
  // need neither the listing photos nor a canonical cutout.
  const loadProduct = async (): Promise<
    { canonical: CanonicalProduct; productPng: Uint8Array } | RenderCreativesOutcome
  > => {
    const pictures = foundPictures.filter(
      (asset): asset is Asset =>
        asset !== null &&
        asset.state === "active" &&
        asset.license === "Mercado Livre listing photo",
    );
    if (pictures.length === 0) return missingContent("no_source_picture");
    const productId = productIdFromOffer(offer);
    if (!productId) return missingContent("listing_product_id_missing");
    let canonical: CanonicalProduct;
    try {
      canonical = await deps.canonical({
        workspaceId: input.workspaceId,
        productId,
        sourceAssets: pictures,
      });
    } catch (error) {
      return failure(error) === "no_source_picture"
        ? missingContent("no_source_picture")
        : failedRender(error);
    }
    const canonicalAsset = await deps.assets.findForWorkspace({
      workspaceId: input.workspaceId,
      assetId: canonical.assetId,
    });
    if (!canonicalAsset || canonicalAsset.state !== "active")
      return failedRender(new Error("canonical_asset_unavailable"));
    const canonicalDownload = await deps.store.createDownload({
      workspaceId: input.workspaceId,
      assetId: canonical.assetId,
    });
    const productPng = await deps.fetchBytes(canonicalDownload.url);
    return { canonical, productPng };
  };
  const loaded = input.slides.some((slide) => !slide.sceneAssetId) ? await loadProduct() : null;
  if (loaded && "status" in loaded) return loaded;
  const canonical = loaded?.canonical;
  const productPng = loaded?.productPng;
  const snapshot = offer.snapshots.find((candidate) => candidate.id === item.offerSnapshotId);
  const price = snapshot ? priceDisplayFromFacts(snapshot.facts, snapshot) : null;
  const inSceneScenes = new Map<
    string,
    {
      bytes: Uint8Array;
      checksum: string;
      fidelity: unknown;
      subjects?: readonly SubjectBox[] | undefined;
    }
  >();
  for (const assetId of new Set(
    input.slides.flatMap((slide) =>
      [slide.sceneAssetId ?? [], slide.storySceneAssetId ?? []].flat(),
    ),
  )) {
    const asset = await deps.assets.findForWorkspace({ workspaceId: input.workspaceId, assetId });
    if (!asset || asset.state !== "active" || !asset.mimeType.startsWith("image/"))
      return missingContent("scene_asset_unavailable");
    if (asset.commercialUse !== true) return missingContent("scene_asset_rights_unverified");
    try {
      const download = await deps.store.createDownload({ workspaceId: input.workspaceId, assetId });
      inSceneScenes.set(assetId, {
        bytes: await deps.fetchBytes(download.url),
        checksum: asset.checksum,
        fidelity: asset.metadata?.inSceneFidelity,
        subjects: storedSubjectBoxes(asset.metadata?.inSceneFidelity),
      });
    } catch (error) {
      return failedRender(error);
    }
  }
  const variantsByChannel = new Map(
    variants
      .filter((variant) => variant.contentItemId === item.id)
      .map((variant) => [variant.channelId, variant]),
  );
  const rendered: Array<{
    channelId: string;
    variant: ContentVariant;
    brandHash: string;
    templateVersions: Record<string, number>;
    slides: Array<{
      output: RenderedSlide;
      slideIndex: number;
      metadata: Record<string, unknown>;
      inScene?: boolean;
      sceneFidelity?: unknown;
      quality?: { verdict: QualityVerdict; score: number };
    }>;
  }> = [];
  const fallbacks = new Set<string>();
  const previousCreatives = await deps.assets.listByMetadata({
    workspaceId: input.workspaceId,
    role: "creative",
    key: "nicheId",
    value: niche.id,
  });
  const recentSceneIds = previousCreatives
    .slice(0, 5)
    .map((asset) => asset.metadata?.sceneAssetId)
    .filter((id): id is string => typeof id === "string");
  // Re-rendering a slide reuses the scene it was last rendered with while that asset is active.
  const pinnedBySlide = new Map<number, string>();
  for (const asset of await deps.assets.listByMetadata({
    workspaceId: input.workspaceId,
    role: "creative",
    key: "contentItemId",
    value: item.id,
  })) {
    const slideIndex = asset.metadata?.slideIndex;
    const pinned = pinnedSceneId(asset.metadata);
    if (typeof slideIndex === "number" && pinned && !pinnedBySlide.has(slideIndex))
      pinnedBySlide.set(slideIndex, pinned);
  }
  const sceneByRole = new Map<string, PickedScene>();
  const sceneBytes = new Map<string, Uint8Array>();
  const sceneChecksums = new Map<string, string>();

  for (const requested of input.channels) {
    const [channel, variant] = await Promise.all([
      deps.channels.findForWorkspace({
        workspaceId: input.workspaceId,
        channelId: requested.channelId,
      }),
      Promise.resolve(variantsByChannel.get(requested.channelId)),
    ]);
    if (!channel || channel.status !== "active" || channel.kind !== requested.kind || !variant)
      return missingContent("channel_not_found");
    if (variant.workspaceId !== input.workspaceId || variant.contentItemId !== item.id)
      return missingContent("channel_variant_mismatch");
    const brand = mergeBrandKit(
      record(workspaceContext?.brandKit) as BrandKitOverride,
      record(niche.context?.brandKit) as BrandKitOverride,
      record(channel.context?.brandKit) as BrandKitOverride,
    );
    const brandHash = brandKitHash(brand);
    let logo: { png: Uint8Array } | undefined;
    if (brand.logoLightAssetId) {
      const logoAsset = await deps.assets.findForWorkspace({
        workspaceId: input.workspaceId,
        assetId: brand.logoLightAssetId,
      });
      if (logoAsset?.state === "active") {
        const download = await deps.store.createDownload({
          workspaceId: input.workspaceId,
          assetId: logoAsset.id,
        });
        logo = { png: await deps.fetchBytes(download.url) };
      }
    }
    const slideOutputs: Array<{
      output: RenderedSlide;
      slideIndex: number;
      metadata: Record<string, unknown>;
      inScene?: boolean;
      sceneFidelity?: unknown;
      quality?: { verdict: QualityVerdict; score: number };
    }> = [];
    for (const spec of input.slides) {
      const scenePreset = presetForChannelKind(channel.kind) ?? presetForCanvas(requested.canvas);
      const sceneId =
        requested.canvas === "story"
          ? (spec.storySceneAssetId ?? spec.sceneAssetId)
          : spec.sceneAssetId;
      const inScene = sceneId ? inSceneScenes.get(sceneId) : undefined;
      if (sceneId && inScene) {
        const template = templateFor(spec.template, requested.canvas);
        const cta =
          spec.index === spec.total
            ? {
                kind: scenePreset.cta.default,
                text: CTA_TEXT[scenePreset.cta.default],
                ...(scenePreset.cta.requiresWorkflow?.[scenePreset.cta.default]
                  ? { requiresWorkflow: scenePreset.cta.requiresWorkflow[scenePreset.cta.default] }
                  : {}),
              }
            : undefined;
        // The price pill is drawn from verified facts wherever the copy asks for a price badge.
        // The price slide always shows the verified price pill (De/por when both prices are verified).
        const slidePrice = (spec.badge || spec.template === "price") && price ? price : undefined;
        let output: RenderedSlide;
        try {
          output = await deps.renderer.render({
            canvas: requested.canvas,
            template,
            spec: { ...spec, disclosure: scenePreset.disclosure.text },
            brand,
            product: { inScene: true },
            background: { png: inScene.bytes },
            preset: scenePreset.id,
            ...(slidePrice ? { price: slidePrice } : {}),
            ...(cta ? { cta: cta.text } : {}),
            ...(logo ? { logo } : {}),
            ...(inScene.subjects ? { subjects: inScene.subjects } : {}),
          });
        } catch (error) {
          return failedRender(error);
        }
        const boxes = output.layout.boxes ?? {};
        const dark = brand.palette.dark ?? brand.palette.primary;
        const quality = await judgeSlideQuality({
          preset: scenePreset,
          canvas: { w: output.width, h: output.height },
          boxes,
          ink: output.layout.ink,
          // Price and CTA labels follow pillLabelColour on the accent pill; the rest is dark ink.
          textColours: {
            headline: dark,
            body: dark,
            price: pillLabelColour(brand.palette.accent, dark),
            cta: pillLabelColour(brand.palette.accent, dark),
            disclosure: "#ffffff",
          },
          ...(output.layout.subjectLayout
            ? { collisions: output.layout.subjectLayout.collisions }
            : {}),
          image: output.bytes,
          ...(deps.quality ? { measureContrast: deps.quality.measureContrast } : {}),
        });
        const creativeDocument: CreativeDocument = {
          version: 1,
          rendererVersion: RENDERER_VERSION,
          brandKitHash: brandHash,
          preset: scenePreset.id,
          layoutFamily: "character_product",
          layers: {
            scene: { assetId: sceneId, checksum: inScene.checksum },
            product: { mode: "in_scene" },
            ...(logo && brand.logoLightAssetId
              ? { logo: { assetId: brand.logoLightAssetId } }
              : {}),
          },
          copy: spec,
          ...(slidePrice ? { price: slidePrice } : {}),
          ...(cta ? { cta } : {}),
          boxes,
          ...(output.layout.subjectLayout ? { subjectLayout: output.layout.subjectLayout } : {}),
          quality,
        };
        slideOutputs.push({
          output,
          slideIndex: spec.index,
          inScene: true,
          quality: { verdict: quality.verdict, score: quality.score },
          sceneFidelity: inScene.fidelity,
          metadata: {
            creativeDocument,
            role: "creative",
            nicheId: niche.id,
            contentItemId: item.id,
            channelId: channel.id,
            slideIndex: spec.index,
            templateId: template.id,
            templateVersion: template.version,
            rendererVersion: RENDERER_VERSION,
            brandKitHash: brandHash,
            sceneAssetId: sceneId,
            productMode: "in_scene",
            canonicalAssetId: null,
            fallbacks: [...fallbacks],
          },
        });
        continue;
      }
      if (!canonical || !productPng) return failedRender(new Error("canonical_product_missing"));
      const role = roleFor(spec);
      let picked: PickedScene | undefined;
      const pinnedId = pinnedBySlide.get(spec.index);
      if (pinnedId) {
        const pinnedAsset = await deps.assets.findForWorkspace({
          workspaceId: input.workspaceId,
          assetId: pinnedId,
        });
        if (pinnedAsset?.state === "active") picked = { assetId: pinnedId, source: "bank" };
      }
      picked ??= sceneByRole.get(role);
      if (!picked) {
        const template = templateFor(spec.template, requested.canvas);
        const plan = scenePlanFor({
          role,
          template,
          nicheSetting: niche.name,
          paletteHint: brand.palette.primary,
        });
        picked = await deps.scenes({
          workspaceId: input.workspaceId,
          nicheId: niche.id,
          plan,
          recentSceneIds,
          correlationId: item.id,
        });
        sceneByRole.set(role, picked);
      }
      let background: { png: Uint8Array } | { procedural: true } = { procedural: true };
      let sceneAssetId: string | null = null;
      if ("procedural" in picked) {
        fallbacks.add("scene:procedural");
      } else {
        try {
          let bytes = sceneBytes.get(picked.assetId);
          if (!bytes) {
            const asset = await deps.assets.findForWorkspace({
              workspaceId: input.workspaceId,
              assetId: picked.assetId,
            });
            if (!asset || asset.state !== "active") throw new Error("scene_asset_unavailable");
            const download = await deps.store.createDownload({
              workspaceId: input.workspaceId,
              assetId: picked.assetId,
            });
            bytes = await deps.fetchBytes(download.url);
            sceneBytes.set(picked.assetId, bytes);
            sceneChecksums.set(picked.assetId, asset.checksum);
          }
          background = { png: bytes };
          sceneAssetId = picked.assetId;
        } catch {
          fallbacks.add("scene:procedural");
        }
      }
      const template = templateFor(spec.template, requested.canvas);
      let output: RenderedSlide;
      try {
        output = await deps.renderer.render({
          canvas: requested.canvas,
          template,
          spec: {
            ...spec,
            ...(spec.template === "cta" && disclosurePolicy[channel.kind]?.slide
              ? { disclosure: disclosurePolicy[channel.kind]?.slide }
              : {}),
          },
          brand,
          product: { png: productPng, mode: canonical.mode },
          background,
          ...(logo ? { logo } : {}),
        });
      } catch (error) {
        return failedRender(error);
      }
      const creativeDocument: CreativeDocument = {
        version: 1,
        rendererVersion: RENDERER_VERSION,
        brandKitHash: brandHash,
        preset: (presetForChannelKind(channel.kind) ?? presetForCanvas(requested.canvas)).id,
        layoutFamily: "product_cutout",
        layers: {
          ...(sceneAssetId
            ? {
                scene: {
                  assetId: sceneAssetId,
                  checksum: sceneChecksums.get(sceneAssetId) ?? "",
                },
              }
            : {}),
          product: { mode: canonical.mode, assetId: canonical.assetId },
          ...(logo && brand.logoLightAssetId ? { logo: { assetId: brand.logoLightAssetId } } : {}),
        },
        copy: spec,
        boxes: output.product ? { subject: output.product.region } : {},
      };
      slideOutputs.push({
        output,
        slideIndex: spec.index,
        metadata: {
          creativeDocument,
          role: "creative",
          nicheId: niche.id,
          contentItemId: item.id,
          channelId: channel.id,
          slideIndex: spec.index,
          templateId: template.id,
          templateVersion: template.version,
          rendererVersion: RENDERER_VERSION,
          brandKitHash: brandHash,
          sceneAssetId,
          canonicalAssetId: canonical.assetId,
          fallbacks: [...fallbacks],
        },
      });
    }
    rendered.push({
      channelId: channel.id,
      variant,
      brandHash,
      templateVersions: Object.fromEntries(
        input.slides.map((spec) => [
          spec.template,
          templateFor(spec.template, requested.canvas).version,
        ]),
      ),
      slides: slideOutputs,
    });
  }

  const visualSpec = productVisualSpecFor(offer.title, snapshot?.facts ?? []);
  const fidelityFor = async (
    output: RenderedSlide,
    inScene: boolean,
    sceneFidelity: unknown,
  ): Promise<FidelityReport | undefined> => {
    if (inScene) {
      // A stored VLM result for this scene is judged deterministically (VLM never approves
      // alone). Without one the slide stays "warn" for the human product check.
      const stored = parseStoredInSceneFidelity(sceneFidelity, visualSpec);
      if (!stored.vlm)
        return {
          ...UNMEASURED_FIDELITY,
          verdict: "warn",
          reasons: ["in_scene_unverified"],
          thresholdSet: "in_scene_unverified",
        };
      const judged = judgeInSceneFidelity({ spec: visualSpec, ...stored });
      return {
        ...UNMEASURED_FIDELITY,
        verdict: judged.verdict === "review" ? "warn" : judged.verdict,
        reasons:
          judged.verdict === "pass"
            ? []
            : judged.verdict === "review"
              ? ["in_scene_unverified", ...judged.reasons]
              : judged.reasons,
        thresholdSet: "in_scene_vlm",
      };
    }
    if (!deps.fidelity) return undefined;
    let metrics: FidelityMetrics = UNMEASURED_FIDELITY;
    if (output.product) {
      try {
        metrics = await deps.fidelity.measurer.measure({
          original: output.product.layer,
          rendered: output.bytes,
          region: output.product.region,
        });
      } catch {
        // Unmeasured is never a pass: judgeFidelity routes the slide to review.
      }
    }
    return judgeFidelity(metrics, deps.fidelity.thresholds);
  };

  const storeOverlay = async (
    workspaceId: WorkspaceId,
    output: RenderedSlide,
    metadata: Record<string, unknown>,
  ): Promise<string> => {
    const bytes = output.overlay as Uint8Array;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const created = createAsset({
      workspaceId,
      mimeType: "image/png",
      checksum,
      width: output.width,
      height: output.height,
      provenance: "generated",
      license: "Rendered by Money Maker",
      metadata: {
        role: "slide_overlay",
        contentItemId: metadata.contentItemId,
        slideIndex: metadata.slideIndex,
      },
    });
    if (!created.ok) throw new Error(`overlay_asset_invalid:${created.code}`);
    await deps.store.putObject({
      workspaceId,
      assetId: created.asset.id,
      mimeType: created.asset.mimeType,
      checksum,
      width: created.asset.width,
      height: created.asset.height,
      bytes,
    });
    await deps.assets.create(created.asset);
    await deps.assets.updateState({ workspaceId, assetId: created.asset.id, state: "active" });
    return created.asset.id;
  };

  const assetIdsByChannel: Record<string, string[]> = {};
  for (const result of rendered) {
    const assetIds: string[] = [];
    const fidelitySlides: Array<FidelityReport & { slideIndex: number }> = [];
    const qualitySlides: Array<{ slideIndex: number; verdict: QualityVerdict; score: number }> = [];
    // Threads carries one image: the cover slide.
    const kind = input.channels.find((channel) => channel.channelId === result.channelId)?.kind;
    const isThreads = kind === "threads";
    for (const slide of isThreads ? result.slides.slice(0, 1) : result.slides) {
      const report = await fidelityFor(slide.output, slide.inScene === true, slide.sceneFidelity);
      if (report) fidelitySlides.push({ ...report, slideIndex: slide.slideIndex });
      if (slide.quality) qualitySlides.push({ slideIndex: slide.slideIndex, ...slide.quality });
      // A carousel is the Reel's source: its text layer is kept so the Reel can move the scene
      // (2.5D) under still text without drawing the slide again.
      const overlayAssetId =
        kind === "instagram_carousel" && slide.inScene && slide.output.overlay
          ? await storeOverlay(input.workspaceId, slide.output, slide.metadata)
          : undefined;
      const checksum = createHash("sha256").update(slide.output.bytes).digest("hex");
      const created = createAsset({
        workspaceId: input.workspaceId,
        mimeType: slide.output.mimeType,
        checksum,
        width: slide.output.width,
        height: slide.output.height,
        provenance: "generated",
        license: "Rendered by Money Maker from Mercado Livre listing photo and licensed scene",
        metadata: { ...slide.metadata, ...(overlayAssetId ? { overlayAssetId } : {}) },
      });
      if (!created.ok) throw new Error(`rendered_asset_invalid:${created.code}`);
      await deps.store.putObject({
        workspaceId: input.workspaceId,
        assetId: created.asset.id,
        mimeType: created.asset.mimeType,
        checksum,
        width: created.asset.width,
        height: created.asset.height,
        bytes: slide.output.bytes,
      });
      await deps.assets.create(created.asset);
      const active = await deps.assets.updateState({
        workspaceId: input.workspaceId,
        assetId: created.asset.id,
        state: "active",
      });
      if (!active) throw new Error("rendered_asset_activation_failed");
      assetIds.push(active.id);
    }
    assetIdsByChannel[result.channelId] = assetIds;
    // The whole carousel, not only each slide (brief 14); a single cover has no sequence.
    const sequence =
      result.slides.length > 1
        ? (() => {
            const report = judgeCarouselSequence(
              result.slides.flatMap((slide) => {
                const spec = input.slides.find((entry) => entry.index === slide.slideIndex);
                return spec
                  ? [
                      {
                        index: spec.index,
                        template: spec.template,
                        headline: spec.headline,
                        // Cut-out slides share bank scenes per role by design; only in-scene
                        // slots, drawn one per slide, count as a repeated scene.
                        sceneAssetId:
                          slide.inScene && typeof slide.metadata.sceneAssetId === "string"
                            ? slide.metadata.sceneAssetId
                            : null,
                      },
                    ]
                  : [];
              }),
            );
            return { verdict: report.verdict, reasons: report.reasons };
          })()
        : undefined;
    await deps.content.updateVariant({
      ...result.variant,
      assetIds,
      creativeFeatures: {
        ...deriveCreativeFeatures({
          slides: input.slides,
          price,
          documents: result.slides.map(
            (slide) => slide.metadata.creativeDocument as CreativeDocument,
          ),
        }),
        // An operator's explicit choice, or an earlier derivation, is never overwritten.
        ...result.variant.creativeFeatures,
      },
      creativeRender: {
        state: "rendered",
        // An auto package that lost its in-scene art keeps saying so after the cut-out render.
        ...(result.variant.creativeRender?.reason?.startsWith("in_scene_fallback")
          ? { reason: result.variant.creativeRender.reason }
          : {}),
        templateVersions: result.templateVersions,
        rendererVersion: RENDERER_VERSION,
        brandKitHash: result.brandHash,
        ...(deps.fidelity || fidelitySlides.length > 0
          ? {
              fidelity: {
                verdict: worstFidelityVerdict(fidelitySlides.map((slide) => slide.verdict)),
                slides: fidelitySlides,
              },
            }
          : {}),
        ...(qualitySlides.length > 0 || sequence
          ? {
              quality: {
                verdict: worstQualityVerdict([
                  ...qualitySlides.map((slide) => slide.verdict),
                  ...(sequence ? [sequence.verdict] : []),
                ]),
                slides: qualitySlides,
                ...(sequence ? { sequence } : {}),
              },
            }
          : {}),
      },
    });
  }
  return { status: "rendered", assetIdsByChannel, fallbacks: [...fallbacks] };
};
