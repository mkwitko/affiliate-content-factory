import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { createAsset, type Asset } from "../assets/asset.js";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import type { PixelBox } from "./creative-renderer.js";
import { judgeCutout, judgeSegmentation, type MaskMetrics } from "./cutout-qa.js";

export type PictureClass = Readonly<{
  whiteness: number;
  edgeDensity: number;
  suggested: "local-white" | "segment" | "framed";
}>;
export type Cutout = Readonly<{
  png: Uint8Array;
  width: number;
  height: number;
  metrics: MaskMetrics;
}>;

/** Output of an AI foreground segmenter: a greyscale PNG mask, white = product. */
export type Segmentation = Readonly<{
  maskPng: Uint8Array;
  /** Foreground bounds in mask pixels; zero size when nothing was found. */
  bbox: PixelBox;
  /** 0..1, adapter-defined; judged against an injected, calibrated minimum. */
  confidence: number;
}>;
export interface ImageSegmenter {
  segment(input: Readonly<{ bytes: Uint8Array; mimeType: string }>): Promise<Segmentation>;
}

export type CanonicalProduct = Readonly<{
  assetId: string;
  mode: "cutout" | "framed";
  sourceAssetId: string;
  width: number;
  height: number;
}>;

export type CanonicalProductDeps = Readonly<{
  assets: Pick<AssetRepository, "create" | "updateState" | "findByMetadata">;
  store: Pick<AssetStore, "putObject" | "createDownload">;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  cutout: (bytes: Uint8Array) => Promise<Cutout>;
  classify: (bytes: Uint8Array) => Promise<PictureClass>;
  /**
   * Experimental AI background removal for the `segment` picture class only (spec 8.3). Absent,
   * failing or unconvincing segmentation keeps the framed original; nothing is ever repainted.
   */
  segment?: Readonly<{
    segmenter: ImageSegmenter;
    /** Cuts the original photo's own pixels with the mask. */
    applyMask: (bytes: Uint8Array, maskPng: Uint8Array) => Promise<Cutout>;
    minConfidence: number;
  }>;
}>;

export const CUTOUT_VERSION = 1;

const score = (picture: Asset, classification: PictureClass): number =>
  0.5 * classification.whiteness +
  0.3 * Math.min(1, picture.width / 1200) +
  0.2 * (1 - classification.edgeDensity * 10) -
  (classification.suggested === "framed" ? 0.5 : 0);

export const ensureCanonicalProduct = async (
  deps: CanonicalProductDeps,
  input: Readonly<{
    workspaceId: WorkspaceId;
    productId: string;
    sourceAssets: readonly Asset[];
  }>,
): Promise<CanonicalProduct> => {
  if (input.sourceAssets.length === 0) throw new Error("no_source_picture");
  // A framed canonical made only because no segmenter existed is retried once one is configured.
  const awaitsSegmenter = (metadata: Asset["metadata"]) =>
    deps.segment !== undefined && metadata?.qaReason === "segment";

  const cached = await deps.assets.findByMetadata({
    workspaceId: input.workspaceId,
    role: "canonical_product",
    key: "productId",
    value: input.productId,
  });
  const cachedSource = input.sourceAssets.find(
    (asset) => asset.checksum === cached?.metadata?.sourceChecksum,
  );
  if (
    cached &&
    cachedSource &&
    cached.metadata?.cutoutVersion === CUTOUT_VERSION &&
    (cached.metadata.mode === "cutout" || cached.metadata.mode === "framed") &&
    !awaitsSegmenter(cached.metadata)
  ) {
    return {
      assetId: cached.id,
      mode: cached.metadata.mode,
      sourceAssetId:
        typeof cached.metadata.sourceAssetId === "string"
          ? cached.metadata.sourceAssetId
          : cachedSource.id,
      width: cached.width,
      height: cached.height,
    };
  }

  const candidates = await Promise.all(
    input.sourceAssets.map(async (asset) => {
      const target = await deps.store.createDownload({
        workspaceId: input.workspaceId,
        assetId: asset.id,
      });
      const bytes = await deps.fetchBytes(target.url);
      const classification = await deps.classify(bytes);
      return { asset, bytes, classification, score: score(asset, classification) };
    }),
  );
  const best = candidates.sort((left, right) => right.score - left.score)[0];
  if (!best) throw new Error("no_source_picture");

  const cacheMetadata = cached?.metadata;
  if (
    cached &&
    cacheMetadata?.cutoutVersion === CUTOUT_VERSION &&
    cacheMetadata.sourceChecksum === best.asset.checksum &&
    (cacheMetadata.mode === "cutout" || cacheMetadata.mode === "framed") &&
    !awaitsSegmenter(cacheMetadata)
  ) {
    return {
      assetId: cached.id,
      mode: cacheMetadata.mode,
      sourceAssetId: best.asset.id,
      width: cached.width,
      height: cached.height,
    };
  }

  let accepted: Readonly<{ cutout: Cutout; method: "local-white" | "segment" }> | undefined;
  let segmentConfidence: number | undefined;
  let qaReason: string | undefined =
    best.classification.suggested === "local-white" ? undefined : best.classification.suggested;
  if (best.classification.suggested === "local-white") {
    const result = await deps.cutout(best.bytes);
    const verdict = judgeCutout(result.metrics);
    if (verdict.ok) accepted = { cutout: result, method: "local-white" };
    else qaReason = verdict.reason;
  } else if (best.classification.suggested === "segment" && deps.segment) {
    try {
      const segmentation = await deps.segment.segmenter.segment({
        bytes: best.bytes,
        mimeType: best.asset.mimeType,
      });
      segmentConfidence = segmentation.confidence;
      const result = await deps.segment.applyMask(best.bytes, segmentation.maskPng);
      const verdict = judgeSegmentation(
        result.metrics,
        segmentation.confidence,
        deps.segment.minConfidence,
      );
      if (verdict.ok) accepted = { cutout: result, method: "segment" };
      else qaReason = verdict.reason;
    } catch {
      qaReason = "segmenter_failed";
    }
  }
  if (accepted) qaReason = undefined;
  const bytes = accepted?.cutout.png ?? best.bytes;
  const mimeType = accepted ? "image/png" : best.asset.mimeType;
  const width = accepted?.cutout.width ?? best.asset.width;
  const height = accepted?.cutout.height ?? best.asset.height;
  const mode: CanonicalProduct["mode"] = accepted ? "cutout" : "framed";

  const metadata = {
    role: "canonical_product",
    productId: input.productId,
    sourceAssetId: best.asset.id,
    sourceChecksum: best.asset.checksum,
    cutoutVersion: CUTOUT_VERSION,
    mode,
    cutoutMethod: accepted?.method ?? "framed",
    ...(qaReason ? { qaReason } : {}),
    ...(segmentConfidence !== undefined ? { segmentConfidence } : {}),
  };
  const created = createAsset({
    workspaceId: input.workspaceId,
    mimeType,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    width,
    height,
    provenance: "generated",
    license:
      mode === "cutout"
        ? "Derived from Mercado Livre listing photo (cutout)"
        : "Derived from Mercado Livre listing photo (framed)",
    metadata,
  });
  if (!created.ok) throw new Error(`canonical_asset_invalid:${created.code}`);
  const asset = await deps.assets.create(created.asset);
  await deps.store.putObject({
    workspaceId: input.workspaceId,
    assetId: asset.id,
    mimeType: asset.mimeType,
    checksum: asset.checksum,
    width: asset.width,
    height: asset.height,
    bytes,
  });
  const active = await deps.assets.updateState({
    workspaceId: input.workspaceId,
    assetId: asset.id,
    state: "active",
  });
  if (!active) throw new Error("canonical_asset_activation_failed");
  return { assetId: asset.id, mode, sourceAssetId: best.asset.id, width, height };
};
