import { describe, expect, it, vi } from "vitest";
import type { WorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import { explainerBackgroundRequest } from "../explainer/background-art.js";
import { pickBankedImage, pickScene } from "./scene-bank.js";
import { sceneKey, scenePrompt } from "./scene-plan.js";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;

const plan = {
  role: "hero",
  productAnchor: "center",
  surface: "table",
  lighting: "top-left",
  nicheSetting: "home office",
  paletteHint: "navy and cyan",
} as const;
const scene = (id: string, usageCount: number, lastUsedAt: string): Asset => ({
  id,
  workspaceId,
  objectKey: "k",
  checksum: id,
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  provenance: "generated",
  commercialUse: true,
  license: "FLUX.1 schnell (Apache-2.0) via Cloudflare Workers AI",
  state: "active",
  metadata: {
    role: "scene",
    sceneKey: "n1:hero:center:table:v2",
    usageCount,
    lastUsedAt,
    fingerprint: id,
  },
});
const deps = (pool: ReturnType<typeof scene>[], over: Record<string, unknown> = {}) => {
  const assets = [...pool];
  return {
    assets: {
      create: vi.fn(async (asset: Asset) => {
        assets.push(asset);
        return asset;
      }),
      updateState: vi.fn(async ({ assetId, state }: { assetId: string; state: Asset["state"] }) => {
        const asset = assets.find((candidate) => candidate.id === assetId);
        return asset ? { ...asset, state } : null;
      }),
      listByMetadata: vi.fn(async () => assets),
      updateMetadata: vi.fn(),
    },
    store: { putObject: vi.fn() },
    generator: {
      generate: vi.fn(async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "image/png" as const,
        width: 1024,
        height: 1024,
        neurons: 173,
      })),
    },
    usage: { record: vi.fn(), sum: vi.fn(async () => 0) },
    budget: () => "generate" as const,
    now: () => new Date("2026-09-26T12:00:00Z"),
    ...over,
  };
};

describe("pickScene", () => {
  it("versions scene keys and excludes products, people and text from its prompt", () => {
    expect(sceneKey("n1", plan)).toBe("n1:hero:center:table:v2");
    expect(scenePrompt(plan)).toContain("large negative space both sides");
    expect(scenePrompt(plan)).toContain("no product, no packaging, no text, no logo, no people");
  });
  it("picks the least used scene outside the recent set", async () => {
    const d = deps(Array.from({ length: 8 }, (_, i) => scene(`s${i}`, i, "2026-09-01T00:00:00Z")));
    expect(
      await pickScene(d, { workspaceId, nicheId: "n1", plan, recentSceneIds: ["s0"] }),
    ).toEqual({ assetId: "s1", source: "bank" });
    expect(d.generator.generate).not.toHaveBeenCalled();
    expect(d.assets.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        assetId: "s1",
        patch: expect.objectContaining({ usageCount: 2 }),
      }),
    );
  });
  it("refills a small pool and records actual usage", async () => {
    const d = deps([scene("s0", 0, "2026-09-01T00:00:00Z")]);
    await pickScene(d, {
      workspaceId,
      nicheId: "n1",
      plan,
      recentSceneIds: [],
      correlationId: "script-1",
    });
    expect(d.generator.generate).toHaveBeenCalledOnce();
    expect(d.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "script-1" }),
    );
    expect(d.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ unit: "neurons", quantity: 173, operation: "scene_generate" }),
    );
  });
  it("reuses scenes at the soft limit and returns procedural at the hard limit or on provider failure", async () => {
    const reuse = deps([scene("s0", 3, "2026-09-01T00:00:00Z")], { budget: () => "reuse_only" });
    expect(
      await pickScene(reuse, { workspaceId, nicheId: "n1", plan, recentSceneIds: [] }),
    ).toEqual({ assetId: "s0", source: "bank" });
    expect(reuse.generator.generate).not.toHaveBeenCalled();
    const empty = deps([scene("s1", 1, "2026-09-01T00:00:00Z")], {
      budget: () => "procedural_only",
    });
    expect(
      await pickScene(empty, { workspaceId, nicheId: "n1", plan, recentSceneIds: [] }),
    ).toEqual({ procedural: true });
    const failed = deps([], {
      generator: {
        generate: vi.fn(async () => {
          throw new Error("scene_provider_error:503");
        }),
      },
    });
    expect(
      await pickScene(failed, { workspaceId, nicheId: "n1", plan, recentSceneIds: [] }),
    ).toEqual({ procedural: true });
  });
  it("generates banked explainer backgrounds at the requested size with the generator's provenance", async () => {
    const generate = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mimeType: "image/png" as const,
      width: 768,
      height: 1344,
      neurons: 0,
      model: "local:z-image-turbo",
      license: "Apache-2.0 (local:z-image-turbo, local)",
      seed: 42,
    }));
    const d = deps([], { generator: { generate } });
    const request = explainerBackgroundRequest("n1", {
      setting: "kitchen",
      style: "sketch_watercolor",
      paletteHint: "warm",
    });
    expect(await pickBankedImage(d, { workspaceId, request, recentSceneIds: [] })).toMatchObject({
      source: "generated",
    });
    expect(generate).toHaveBeenCalledWith(request.prompt, { width: 768, height: 1344 });
    expect(d.assets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        creator: "local:z-image-turbo",
        license: "Apache-2.0 (local:z-image-turbo, local)",
        commercialUse: true,
        metadata: expect.objectContaining({
          role: "explainer_background",
          sceneKey: "n1:explainer:kitchen:sketch_watercolor:v1",
          prompt: request.prompt,
          seed: 42,
          model: "local:z-image-turbo",
        }),
      }),
    );
  });

  it("never grants commercial rights to a generator outside the licence allowlist", async () => {
    const d = deps([], {
      generator: {
        generate: vi.fn(async () => ({
          bytes: new Uint8Array([1]),
          mimeType: "image/png" as const,
          width: 768,
          height: 1344,
          neurons: 0,
          model: "local:ltx-2.3",
        })),
      },
    });
    const request = explainerBackgroundRequest("n1", {
      setting: "sky",
      style: "flat_cartoon",
      paletteHint: "x",
    });
    await pickBankedImage(d, { workspaceId, request, recentSceneIds: [] });
    expect(d.assets.create).toHaveBeenCalledWith(expect.objectContaining({ commercialUse: null }));
  });
});
