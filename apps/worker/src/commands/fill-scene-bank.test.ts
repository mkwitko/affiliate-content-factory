import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { SceneBankDeps } from "@money-maker/core/creatives/scene-bank";
import type { Niche } from "@money-maker/core/niches/niche";
import { decideSceneBudget } from "@money-maker/core/usage/generation-budget";
import { describe, expect, it, vi } from "vitest";
import { fillSceneBank } from "./fill-scene-bank.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const niche: Niche = {
  id: "niche-1",
  workspaceId,
  name: "Home office",
  audience: "Remote workers",
  problem: "Desk clutter",
  editorialVoice: "Practical",
  languages: ["pt-BR"],
  monetizationHypothesis: "Affiliate",
  state: "active",
  kind: "affiliate",
  context: { scene: { surface: "table", nicheSetting: "home office", paletteHint: "deep green" } },
};

const dependencies = () => {
  const assets: Asset[] = [];
  const usage: number[] = [];
  const scenes: SceneBankDeps = {
    assets: {
      listByMetadata: async ({ key, value }) =>
        assets.filter((asset) => asset.metadata?.[key] === value),
      create: async (asset) => {
        assets.push(asset);
        return asset;
      },
      updateState: async ({ assetId, state }) => {
        const index = assets.findIndex((asset) => asset.id === assetId);
        const current = assets[index];
        if (!current) return null;
        const updated = { ...current, state };
        assets[index] = updated;
        return updated;
      },
      updateMetadata: async ({ assetId, patch }) => {
        const index = assets.findIndex((asset) => asset.id === assetId);
        const current = assets[index];
        if (!current) return null;
        const updated = { ...current, metadata: { ...current.metadata, ...patch } };
        assets[index] = updated;
        return updated;
      },
    },
    store: { putObject: async () => undefined },
    generator: {
      generate: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        neurons: 173,
      }),
    },
    usage: {
      sum: async () => usage.reduce((total, value) => total + value, 0),
      record: async (event) => {
        usage.push(event.quantity);
      },
    },
    budget: decideSceneBudget,
    now: () => new Date("2026-09-25T12:00:00.000Z"),
  };
  return { scenes, assets, usage };
};

describe("fillSceneBank", () => {
  it("fills active niche scene keys to eight and stays within the daily generation budget", async () => {
    const { scenes, assets, usage } = dependencies();
    const result = await fillSceneBank(scenes, { workspaceId, niches: [niche] });

    expect(result.generated).toBeLessThanOrEqual(46);
    expect(result.neuronsUsed).toBeLessThanOrEqual(8_000);
    expect(Object.values(result.perKey).every((count) => count <= 8)).toBe(true);
    expect(assets.filter((asset) => asset.state === "active")).toHaveLength(result.generated);
    expect(usage.reduce((total, value) => total + value, 0)).toBe(result.neuronsUsed);
  });

  it("stops without generation when the budget is reuse-only", async () => {
    const { scenes } = dependencies();
    const result = await fillSceneBank(
      { ...scenes, budget: () => "reuse_only" },
      { workspaceId, niches: [niche] },
    );

    expect(result.generated).toBe(0);
    expect(result.neuronsUsed).toBe(0);
  });
  it("fills a styled media niche with two painted backgrounds per setting, portrait, no product scenes", async () => {
    const { scenes, assets } = dependencies();
    const generate = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mimeType: "image/png" as const,
      width: 1024,
      height: 1024,
      neurons: 173,
    }));
    const media: Niche = {
      ...niche,
      id: "niche-media",
      kind: "media",
      context: {
        explainer: { style: "sketch_watercolor" },
        scene: { paletteHint: "warm terracotta" },
      },
    };
    const result = await fillSceneBank(
      { ...scenes, generator: { generate } },
      { workspaceId, niches: [media] },
    );
    expect(Object.keys(result.perKey)).toHaveLength(10);
    expect(Object.values(result.perKey).every((count) => count === 2)).toBe(true);
    expect(result.generated).toBe(20);
    expect(generate).toHaveBeenCalledWith(expect.stringContaining("no people"), {
      width: 768,
      height: 1344,
    });
    expect(assets.every((asset) => asset.metadata?.role === "explainer_background")).toBe(true);
  });

  it("post-processes plates of a media niche with a compositing profile and records it", async () => {
    const { scenes, assets } = dependencies();
    const postProcess = vi.fn(async (_bytes: Uint8Array, _plan: { farValuePull: number }) => ({
      bytes: new Uint8Array([9, 9]),
      mimeType: "image/jpeg" as const,
      record: { compositingVersion: 1 },
    }));
    const media: Niche = {
      ...niche,
      id: "niche-media",
      kind: "media",
      context: {
        explainer: { style: "flat_cartoon", compositing: { depth: { farValuePull: 0.3 } } },
      },
    };
    await fillSceneBank({ ...scenes, postProcess }, { workspaceId, niches: [media] });
    expect(postProcess).toHaveBeenCalled();
    expect(postProcess.mock.calls[0]?.[1]).toMatchObject({ farValuePull: 0.3 });
    expect(assets.every((asset) => asset.mimeType === "image/jpeg")).toBe(true);
    expect(assets[0]?.metadata?.postProcess).toEqual({ compositingVersion: 1 });
  });

  it("leaves plates untouched for a media niche without a profile", async () => {
    const { scenes, assets } = dependencies();
    const postProcess = vi.fn();
    const media: Niche = {
      ...niche,
      id: "niche-media",
      kind: "media",
      context: { explainer: { style: "flat_cartoon" } },
    };
    await fillSceneBank({ ...scenes, postProcess }, { workspaceId, niches: [media] });
    expect(postProcess).not.toHaveBeenCalled();
    expect(assets.every((asset) => asset.metadata?.postProcess === undefined)).toBe(true);
  });

  it("banks one wide plate per location without a pinned plate (v2 slice 24)", async () => {
    const { scenes, assets } = dependencies();
    const generate = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mimeType: "image/png" as const,
      width: 1216,
      height: 1344,
      neurons: 173,
    }));
    const media: Niche = {
      ...niche,
      id: "niche-media",
      kind: "media",
      context: {
        explainer: {
          style: "flat_cartoon",
          locations: [
            {
              id: "office_a",
              name: "Office",
              proceduralFallback: "office",
              zones: [],
              anchors: [],
            },
            {
              id: "pinned",
              name: "Pinned",
              plate: { assetId: "x" },
              proceduralFallback: "store",
              zones: [],
              anchors: [],
            },
          ],
        },
      },
    };
    await fillSceneBank({ ...scenes, generator: { generate } }, { workspaceId, niches: [media] });
    const plates = assets.filter((asset) => asset.metadata?.locationId !== undefined);
    expect(plates.map((asset) => asset.metadata?.sceneKey)).toEqual([
      "niche-media:location:office_a:flat_cartoon:t1",
    ]);
    expect(generate).toHaveBeenCalledWith(
      expect.stringContaining("recurring place called Office"),
      {
        width: 1216,
        height: 1344,
      },
    );
  });
});
