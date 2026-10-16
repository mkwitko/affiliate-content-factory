import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import {
  ensureCanonicalProduct,
  type CanonicalProductDeps,
  type ImageSegmenter,
  type Segmentation,
} from "./canonical-product.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const white: Asset = {
  id: "a1",
  workspaceId,
  objectKey: "k/a1",
  checksum: "c1",
  mimeType: "image/jpeg",
  width: 1200,
  height: 1200,
  provenance: "provider_import",
  commercialUse: null,
  license: "Mercado Livre listing photo",
  state: "active",
};
const goodMetrics = {
  coverage: 0.4,
  margin: 0.05,
  components: 1,
  largestRatio: 1,
  whiteness: 1,
  contrast: 100,
};
const makeDeps = (overrides: Record<string, unknown> = {}) =>
  ({
    assets: {
      create: vi.fn(async (asset: Asset) => asset),
      updateState: vi.fn(async () => ({ ...white, state: "active" as const })),
      findByMetadata: vi.fn(async () => null),
    },
    store: {
      putObject: vi.fn(async () => undefined),
      createDownload: vi.fn(async () => ({ method: "GET" as const, url: "https://storage/a1" })),
    },
    fetchBytes: vi.fn(async () => new Uint8Array([1])),
    classify: vi.fn(async () => ({
      whiteness: 1,
      edgeDensity: 0.02,
      suggested: "local-white" as const,
    })),
    cutout: vi.fn(async () => ({
      png: new Uint8Array([2]),
      width: 1200,
      height: 1200,
      metrics: goodMetrics,
    })),
    ...overrides,
  }) as unknown as CanonicalProductDeps;

describe("ensureCanonicalProduct", () => {
  it("cuts a white-background photo and stores cache metadata", async () => {
    const deps = makeDeps();
    const result = await ensureCanonicalProduct(deps, {
      workspaceId,
      productId: "MLB1",
      sourceAssets: [white],
    });
    expect(result.mode).toBe("cutout");
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "image/png",
        metadata: expect.objectContaining({
          role: "canonical_product",
          productId: "MLB1",
          sourceChecksum: "c1",
          cutoutMethod: "local-white",
          cutoutVersion: 1,
        }),
      }),
    );
  });

  it("returns a matching cached asset without recutting", async () => {
    const cached = {
      ...white,
      id: "canonical",
      mimeType: "image/png",
      metadata: {
        role: "canonical_product",
        productId: "MLB1",
        sourceChecksum: "c1",
        cutoutVersion: 1,
        mode: "cutout",
      },
    };
    const deps = makeDeps({
      assets: {
        create: vi.fn(),
        updateState: vi.fn(),
        findByMetadata: vi.fn(async () => cached),
      },
    });
    const result = await ensureCanonicalProduct(deps, {
      workspaceId,
      productId: "MLB1",
      sourceAssets: [white],
    });
    expect(result.assetId).toBe("canonical");
    expect(deps.fetchBytes).not.toHaveBeenCalled();
    expect(deps.cutout).not.toHaveBeenCalled();
  });

  it("uses framed mode when cutout QA rejects the mask", async () => {
    const deps = makeDeps({
      cutout: vi.fn(async () => ({
        png: new Uint8Array(),
        width: 1,
        height: 1,
        metrics: { ...goodMetrics, contrast: 5 },
      })),
    });
    const result = await ensureCanonicalProduct(deps, {
      workspaceId,
      productId: "MLB1",
      sourceAssets: [white],
    });
    expect(result.mode).toBe("framed");
    expect(deps.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ mode: "framed", qaReason: "low_contrast" }),
      }),
    );
  });

  it("frames the best non-white photo without attempting cutout", async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({
        whiteness: 0.05,
        edgeDensity: 0.1,
        suggested: "segment" as const,
      })),
    });
    const result = await ensureCanonicalProduct(deps, {
      workspaceId,
      productId: "MLB1",
      sourceAssets: [white],
    });
    expect(result.mode).toBe("framed");
    expect(deps.cutout).not.toHaveBeenCalled();
  });

  it("fails when the product has no source picture", async () => {
    await expect(
      ensureCanonicalProduct(makeDeps(), { workspaceId, productId: "MLB1", sourceAssets: [] }),
    ).rejects.toThrow("no_source_picture");
  });

  describe("with an image segmenter", () => {
    const segmentClass = vi.fn(async () => ({
      whiteness: 0.05,
      edgeDensity: 0.1,
      suggested: "segment" as const,
    }));
    /** Fake adapter: returns a fixed mask, or throws when given an Error. */
    const fakeSegmenter = (result: Segmentation | Error): ImageSegmenter => ({
      segment: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    });
    const mask: Segmentation = {
      maskPng: new Uint8Array([9]),
      bbox: { x: 10, y: 10, w: 100, h: 100 },
      confidence: 0.97,
    };
    const segmentDeps = (segmenter: ImageSegmenter, overrides: Record<string, unknown> = {}) =>
      makeDeps({
        classify: segmentClass,
        segment: {
          segmenter,
          applyMask: vi.fn(async () => ({
            png: new Uint8Array([3]),
            width: 1200,
            height: 1200,
            metrics: { ...goodMetrics, whiteness: 0.05, contrast: 4 },
          })),
          minConfidence: 0.9,
        },
        ...overrides,
      });

    it("cuts a segment-class photo with a confident mask", async () => {
      const segmenter = fakeSegmenter(mask);
      const deps = segmentDeps(segmenter);
      const result = await ensureCanonicalProduct(deps, {
        workspaceId,
        productId: "MLB1",
        sourceAssets: [white],
      });
      expect(result.mode).toBe("cutout");
      expect(segmenter.segment).toHaveBeenCalledWith({
        bytes: new Uint8Array([1]),
        mimeType: "image/jpeg",
      });
      expect(deps.segment?.applyMask).toHaveBeenCalledWith(new Uint8Array([1]), mask.maskPng);
      expect(deps.cutout).not.toHaveBeenCalled();
      expect(deps.assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: "image/png",
          metadata: expect.objectContaining({
            mode: "cutout",
            cutoutMethod: "segment",
            segmentConfidence: 0.97,
          }),
        }),
      );
      const metadata = vi.mocked(deps.assets.create).mock.calls[0]?.[0].metadata;
      expect(metadata?.qaReason).toBeUndefined();
    });

    it("frames the photo when the mask confidence is low", async () => {
      const deps = segmentDeps(fakeSegmenter({ ...mask, confidence: 0.4 }));
      const result = await ensureCanonicalProduct(deps, {
        workspaceId,
        productId: "MLB1",
        sourceAssets: [white],
      });
      expect(result.mode).toBe("framed");
      expect(deps.assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: "image/jpeg",
          metadata: expect.objectContaining({
            mode: "framed",
            cutoutMethod: "framed",
            qaReason: "low_confidence",
            segmentConfidence: 0.4,
          }),
        }),
      );
    });

    it("frames the photo when the segmenter fails", async () => {
      const deps = segmentDeps(fakeSegmenter(new Error("process_timeout")));
      const result = await ensureCanonicalProduct(deps, {
        workspaceId,
        productId: "MLB1",
        sourceAssets: [white],
      });
      expect(result.mode).toBe("framed");
      expect(deps.assets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ mode: "framed", qaReason: "segmenter_failed" }),
        }),
      );
    });

    it("never segments a white-background photo", async () => {
      const segmenter = fakeSegmenter(mask);
      const deps = segmentDeps(segmenter, { classify: makeDeps().classify });
      const result = await ensureCanonicalProduct(deps, {
        workspaceId,
        productId: "MLB1",
        sourceAssets: [white],
      });
      expect(result.mode).toBe("cutout");
      expect(segmenter.segment).not.toHaveBeenCalled();
    });

    it("retries a canonical framed only for lack of a segmenter, but keeps other framed caches", async () => {
      const cached = (qaReason: string) => ({
        ...white,
        id: "canonical",
        metadata: {
          role: "canonical_product",
          productId: "MLB1",
          sourceChecksum: "c1",
          cutoutVersion: 1,
          mode: "framed",
          qaReason,
        },
      });
      const retried = segmentDeps(fakeSegmenter(mask));
      vi.mocked(retried.assets.findByMetadata).mockResolvedValue(cached("segment"));
      expect(
        (
          await ensureCanonicalProduct(retried, {
            workspaceId,
            productId: "MLB1",
            sourceAssets: [white],
          })
        ).mode,
      ).toBe("cutout");

      const kept = segmentDeps(fakeSegmenter(mask));
      vi.mocked(kept.assets.findByMetadata).mockResolvedValue(cached("segmenter_failed"));
      const result = await ensureCanonicalProduct(kept, {
        workspaceId,
        productId: "MLB1",
        sourceAssets: [white],
      });
      expect(result.assetId).toBe("canonical");
      expect(kept.segment?.segmenter.segment).not.toHaveBeenCalled();
    });
  });
});
