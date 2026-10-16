import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import { PermanentJobError } from "@money-maker/core/jobs/job";
import { describe, expect, it, vi } from "vitest";
import { createGeneratePlatesHandler, createGeneratePlatesJob } from "./generate-plates.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const png = new Uint8Array([1, 2, 3]);
const niche = (overrides: Record<string, unknown> = {}) => ({
  id: "niche-1",
  workspaceId,
  kind: "media",
  name: "Casa",
  state: "active",
  context: {
    explainer: {
      style: "flat_cartoon",
      locations: [
        {
          id: "office_a",
          name: "Office",
          proceduralFallback: "office",
          plate: {},
          zones: [{ id: "desk" }],
          anchors: [{ id: "desk_left" }],
        },
        {
          id: "kitchen_a",
          name: "Kitchen",
          proceduralFallback: "kitchen",
          plate: { assetId: "x" },
        },
      ],
    },
  },
  ...overrides,
});

const setup = (generatorFails = false) => {
  const assets: Asset[] = [];
  const generate = vi.fn(async () => {
    if (generatorFails) throw new Error("scene_provider_timeout");
    return {
      bytes: png,
      mimeType: "image/png" as const,
      width: 1216,
      height: 1344,
      neurons: 0,
      model: "local:flux-2-klein-4b",
      license: "Apache-2.0 (local:flux-2-klein-4b, local)",
      seed: 7,
    };
  });
  const bank = {
    assets: {
      listByMetadata: async () => assets.filter((asset) => asset.state === "active"),
      create: async (asset: Asset) => {
        assets.push(asset);
        return asset;
      },
      updateState: async ({ assetId, state }: { assetId: string; state: Asset["state"] }) => {
        const index = assets.findIndex((asset) => asset.id === assetId);
        const current = assets[index];
        if (!current) return null;
        assets[index] = { ...current, state };
        return assets[index];
      },
      updateMetadata: async () => null,
    },
    store: { putObject: async () => undefined },
    generator: { generate },
    usage: { sum: async () => 0, record: async () => undefined },
    budget: () => "generate" as const,
    now: () => new Date("2026-09-30T12:00:00Z"),
  };
  const run = (nicheRow: unknown = niche()) =>
    createGeneratePlatesHandler({
      niches: { findForWorkspace: async () => nicheRow as never },
      bank: bank as never,
    })({ payload: { version: 1, workspaceId, identifiers: { nicheId: "niche-1" } } });
  return { run, assets, generate };
};

describe("generate_plates handler", () => {
  it("banks one local plate for the location without a pinned plate, once", async () => {
    const { run, assets, generate } = setup();
    await run();
    await run();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      creator: "local:flux-2-klein-4b",
      commercialUse: true,
      metadata: { locationId: "office_a", role: "explainer_background" },
    });
  });

  it("fails retryably when the generator produced nothing", async () => {
    const { run } = setup(true);
    await expect(run()).rejects.toThrow("plates_missing:1");
    await expect(run()).rejects.not.toBeInstanceOf(PermanentJobError);
  });

  it("fails permanently for an inactive niche", async () => {
    const { run, generate } = setup();
    await expect(run(niche({ state: "paused" }))).rejects.toThrow(PermanentJobError);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("createGeneratePlatesJob", () => {
  it("keeps the envelope to ids and dedupes per niche and day", () => {
    const job = createGeneratePlatesJob({ workspaceId, nicheId: "niche-1", day: "2026-09-30" });
    expect(job.payload).toEqual({
      version: 1,
      workspaceId,
      identifiers: { nicheId: "niche-1" },
    });
    expect(job.idempotencyKey).toBe("generate-plates:niche-1:2026-09-30");
    expect(JSON.stringify(job.payload).length).toBeLessThan(1024);
  });
});
