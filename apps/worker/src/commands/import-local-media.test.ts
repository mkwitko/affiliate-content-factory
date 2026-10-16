import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import { describe, expect, it, vi } from "vitest";
import {
  type ImportLocalMediaDeps,
  importLocalMedia,
  parseLocalMediaManifest,
} from "./import-local-media.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const nicheId = "f11f02f5-f88f-42eb-8869-9f9f59e8c5c5";
const generation = (model: string) => ({
  model,
  weightsLicense: "Apache-2.0",
  tool: "sd.cpp master-4a1b",
  seed: 1234,
  prompt: "a home kitchen, no people",
  promptVersion: 1,
});
const loopItem = {
  kind: "ambient_loop",
  file: "kitchen-1234-loop.mp4",
  background: "kitchen-1234.png",
  generation: generation("local:wan2.2-ti2v-5b"),
};
const backgroundItem = {
  kind: "background",
  file: "kitchen-1234.png",
  setting: "kitchen",
  style: "sketch_watercolor",
  generation: generation("local:z-image-turbo"),
};
// The loop comes first on purpose: backgrounds are imported before the loops that attach to them.
const manifest = (items: readonly unknown[] = [loopItem, backgroundItem]) => ({
  version: 1,
  nicheId,
  items,
});
const parsed = (items?: readonly unknown[]) => {
  const value = parseLocalMediaManifest(manifest(items));
  if (!value) throw new Error("manifest rejected");
  return value;
};
const setup = (
  measure = { width: 1080, height: 1920, durationMs: 2_000, motion: 4.62, seam: 4.53 },
  probe = { mimeType: "image/png", width: 768, height: 1344 },
) => {
  const created: Asset[] = [];
  const deps: ImportLocalMediaDeps = {
    assets: {
      create: vi.fn(async (asset: Asset) => {
        created.push(asset);
        return asset;
      }),
      updateState: vi.fn(async ({ assetId, state }: { assetId: string; state: Asset["state"] }) => {
        const asset = created.find((entry) => entry.id === assetId);
        return asset ? { ...asset, state } : null;
      }),
      findByMetadata: vi.fn(
        async ({ value }: { value: string }) =>
          created.find((asset) => asset.metadata?.fingerprint === value) ?? null,
      ),
    },
    store: { putObject: vi.fn(async () => undefined) },
    // Distinct bytes per file, so each file has its own checksum.
    readFile: vi.fn(async (path: string) => new TextEncoder().encode(path)),
    probeImage: vi.fn(async () => probe),
    measureLoop: vi.fn(async () => measure),
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  };
  return { deps, created };
};

describe("importLocalMedia", () => {
  it("imports backgrounds into the niche bank and attaches passing loops to them", async () => {
    const { deps, created } = setup();
    const result = await importLocalMedia(deps, { workspaceId, folder: "/in", manifest: parsed() });
    expect(result.skipped).toEqual([]);
    const [background, loop] = created;
    expect(background).toMatchObject({
      mimeType: "image/png",
      width: 768,
      height: 1344,
      provenance: "generated",
      creator: "local:z-image-turbo",
      license: "Apache-2.0 (local:z-image-turbo, local)",
      commercialUse: true,
      metadata: {
        role: "explainer_background",
        nicheId,
        setting: "kitchen",
        style: "sketch_watercolor",
        sceneKey: `${nicheId}:explainer:kitchen:sketch_watercolor:v1`,
        generation: generation("local:z-image-turbo"),
        usageCount: 0,
      },
    });
    expect(loop).toMatchObject({
      mimeType: "video/mp4",
      durationMs: 2_000,
      commercialUse: true,
      metadata: {
        role: "ambient_loop",
        backgroundAssetId: background?.id,
        qa: { verdict: "pass", motion: 4.62, seam: 4.53 },
      },
    });
    expect(deps.readFile).toHaveBeenCalledWith("/in/kitchen-1234.png");
    expect(deps.assets.updateState).toHaveBeenCalledTimes(2);
  });

  it("skips a loop that fails seam QA and imports an unlicensed model's loop without rights", async () => {
    const seam = setup({ width: 1080, height: 1920, durationMs: 2_000, motion: 2.32, seam: 88.98 });
    const blocked = await importLocalMedia(seam.deps, {
      workspaceId,
      folder: "/in",
      manifest: parsed(),
    });
    expect(blocked.skipped).toEqual([{ file: "kitchen-1234-loop.mp4", reason: "loop_seam" }]);
    const ltx = setup();
    await importLocalMedia(ltx.deps, {
      workspaceId,
      folder: "/in",
      manifest: parsed([backgroundItem, { ...loopItem, generation: generation("local:ltx-2.3") }]),
    });
    expect(ltx.created[1]?.commercialUse).toBeNull();
  });

  it("is idempotent: a second run skips files already imported", async () => {
    const { deps, created } = setup();
    await importLocalMedia(deps, { workspaceId, folder: "/in", manifest: parsed() });
    const again = await importLocalMedia(deps, { workspaceId, folder: "/in", manifest: parsed() });
    expect(again.imported).toEqual([]);
    expect(again.skipped.map((entry) => entry.reason)).toEqual([
      "already_imported",
      "already_imported",
    ]);
    expect(created).toHaveLength(2);
  });

  it("names missing files, small images and loops without their background", async () => {
    const { deps } = setup(undefined, { mimeType: "image/png", width: 256, height: 256 });
    const result = await importLocalMedia(deps, { workspaceId, folder: "/in", manifest: parsed() });
    expect(result.skipped).toEqual([
      { file: "kitchen-1234.png", reason: "image_too_small" },
      { file: "kitchen-1234-loop.mp4", reason: "background_missing" },
    ]);
  });
});

describe("parseLocalMediaManifest", () => {
  it("rejects paths, unknown settings or styles, missing provenance and other versions", () => {
    for (const items of [
      [{ ...backgroundItem, file: "../secrets.png" }],
      [{ ...backgroundItem, setting: "moon" }],
      [{ ...backgroundItem, style: "oil" }],
      [{ ...backgroundItem, generation: { model: "local:z-image-turbo" } }],
      [{ ...loopItem, background: "a/b.png" }],
      [{ ...backgroundItem, kind: "character" }],
    ])
      expect(parseLocalMediaManifest(manifest(items))).toBeNull();
    expect(parseLocalMediaManifest({ ...manifest(), version: 2 })).toBeNull();
    expect(parseLocalMediaManifest({ ...manifest(), nicheId: "../x" })).toBeNull();
  });

  it("stores the post-processed background and records the step, keeping the source fingerprint", async () => {
    const { deps, created } = setup();
    const processed = new TextEncoder().encode("processed-jpeg");
    const withProcess: ImportLocalMediaDeps = {
      ...deps,
      postProcess: vi.fn(async () => ({
        bytes: processed,
        mimeType: "image/jpeg" as const,
        record: { compositingVersion: 1, saturationScale: 0.8 },
      })),
    };
    const result = await importLocalMedia(withProcess, {
      workspaceId,
      folder: "/in",
      manifest: parsed([backgroundItem]),
    });
    expect(result.skipped).toEqual([]);
    const [background] = created;
    expect(background).toMatchObject({
      mimeType: "image/jpeg",
      byteSize: processed.byteLength,
      metadata: { postProcess: { compositingVersion: 1, saturationScale: 0.8 } },
    });
    const put = vi.mocked(deps.store.putObject).mock.calls[0]?.[0];
    expect(put?.bytes).toEqual(processed);
    expect(put?.checksum).toBe(background?.checksum);
    // Re-running finds the source fingerprint and skips.
    const again = await importLocalMedia(withProcess, {
      workspaceId,
      folder: "/in",
      manifest: parsed([backgroundItem]),
    });
    expect(again.skipped).toEqual([{ file: backgroundItem.file, reason: "already_imported" }]);
  });

  it("banks a background marked with a location under the location plate key", async () => {
    const { deps, created } = setup();
    await importLocalMedia(deps, {
      workspaceId,
      folder: "/in",
      manifest: parsed([{ ...backgroundItem, location: "office_a" }]),
    });
    expect(created[0]?.metadata).toMatchObject({
      sceneKey: `${nicheId}:location:office_a:sketch_watercolor:t1`,
      locationId: "office_a",
      promptTemplateVersion: 1,
    });
  });
});
