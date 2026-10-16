import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Asset } from "./asset.js";
import {
  dependentAssetIds,
  findGeneratedClip,
  findUnverifiedGeneratedClip,
  hasAiDisclosure,
  resolveAssetRights,
} from "./asset-rights.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const asset = (id: string, overrides: Partial<Asset> = {}): Asset => ({
  id,
  workspaceId,
  objectKey: `workspaces/${workspaceId}/assets/${id}`,
  checksum: `sha-${id}`,
  commercialUse: true,
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  provenance: "generated",
  license: "model-license",
  state: "active",
  ...overrides,
});

describe("resolveAssetRights", () => {
  it("inherits rights from every transitive source and includes them in the resolution", async () => {
    const source = asset("source");
    const input = asset("input", {
      provenance: "rendered",
      commercialUse: null,
      metadata: { sourceAssetIds: ["source"] },
    });
    const output = asset("output", {
      provenance: "rendered",
      commercialUse: null,
      metadata: { sourceAssetIds: ["input"] },
    });
    const assets = new Map([
      [source.id, source],
      [input.id, input],
    ]);
    const resolved = await resolveAssetRights({
      workspaceId,
      assets: [output],
      findAsset: async (id) => assets.get(id) ?? null,
    });
    expect(resolved.map(({ id, commercialUse }) => [id, commercialUse])).toEqual([
      ["input", true],
      ["output", true],
      ["source", true],
    ]);
  });

  it("fails closed for missing, cross-workspace, cyclic, and deeply nested inputs", async () => {
    const broken = asset("broken", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["missing"] },
    });
    const foreign = asset("foreign", {
      workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
    });
    const foreignParent = asset("foreign-parent", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["foreign"] },
    });
    const cycleA = asset("cycle-a", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["cycle-b"] },
    });
    const cycleB = asset("cycle-b", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["cycle-a"] },
    });
    const assets = new Map([
      [foreign.id, foreign],
      [cycleA.id, cycleA],
      [cycleB.id, cycleB],
    ]);
    const resolved = await resolveAssetRights({
      workspaceId,
      assets: [broken, foreignParent, cycleA],
      findAsset: async (id) => assets.get(id) ?? null,
    });
    expect(
      resolved
        .filter(({ id }) => ["broken", "foreign-parent", "cycle-a", "cycle-b"].includes(id))
        .every(({ commercialUse }) => commercialUse === null),
    ).toBe(true);
    expect(resolved.some(({ id }) => id === "foreign" || id === "missing")).toBe(false);
  });
});

describe("dependentAssetIds", () => {
  it("finds rendered descendants without including unrelated assets", () => {
    const source = asset("source");
    const render = asset("render", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["source"] },
    });
    const final = asset("final", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["render"] },
    });
    const other = asset("other", {
      provenance: "rendered",
      metadata: { sourceAssetIds: ["another"] },
    });
    expect(dependentAssetIds("source", [source, render, final, other])).toEqual([
      "final",
      "render",
      "source",
    ]);
  });
});

describe("findUnverifiedGeneratedClip", () => {
  const clip = (commercialUse: boolean | null) =>
    asset("clip", {
      commercialUse,
      license: "internal",
      metadata: { role: "stage_artifact", stage: "scene_clip" },
    });
  const render = asset("render", {
    provenance: "rendered",
    commercialUse: null,
    metadata: { sourceAssetIds: ["clip", "plate"] },
  });
  const plate = asset("plate", { commercialUse: true, mimeType: "image/png" });
  const find = (source: Asset, root: Asset = render) =>
    findUnverifiedGeneratedClip({
      workspaceId,
      assets: [root],
      findAsset: async (id) => ({ clip: source, plate, render })[id] ?? null,
    });

  it("names a scene clip whose rights are null or false, found through the rendered lineage", async () => {
    expect((await find(clip(null)))?.id).toBe("clip");
    expect((await find(clip(false)))?.id).toBe("clip");
  });
  it("finds any generated scene clip in the lineage, verified or not", async () => {
    const modelled = {
      ...clip(true),
      metadata: { role: "stage_artifact", stage: "scene_clip", model: "m1" },
    };
    const other = asset("plate", { commercialUse: null, metadata: { role: "scene" } });
    const run = (assets: readonly Asset[]) =>
      findGeneratedClip({ workspaceId, assets, findAsset: async () => null });
    expect((await run([other, modelled]))?.id).toBe("clip");
    expect(await run([other])).toBeUndefined();
  });
  it("recognises common pt-BR and English AI disclosures in a caption", () => {
    for (const caption of [
      "#publi Organizador incrível #IA",
      "Cenas geradas por IA. Link na bio",
      "Vídeo feito com IA",
      "Conteúdo criado com inteligência artificial",
      "Imagens geradas com inteligência artificial",
      "#AIgenerated tidy kitchen",
    ])
      expect(hasAiDisclosure(caption)).toBe(true);
    for (const caption of ["#publi Organizador de gaveta", "Ideia genial para a cozinha", "#iaiá"])
      expect(hasAiDisclosure(caption)).toBe(false);
  });
  it("passes only when the clip model is on the G0 allowlist", async () => {
    const modelled = {
      ...clip(true),
      metadata: { role: "stage_artifact", stage: "scene_clip", model: "m1" },
    };
    const run = (set?: ReadonlySet<string>) =>
      findUnverifiedGeneratedClip({
        workspaceId,
        assets: [modelled],
        findAsset: async () => null,
        ...(set ? { verifiedModels: set } : {}),
      });
    expect((await run())?.id).toBe("clip");
    expect((await run(new Set(["agnes:other"])))?.id).toBe("clip");
    expect(await run(new Set(["agnes:m1"]))).toBeUndefined();
  });
  it("ignores other generated assets with unknown rights, so existing formats are unaffected", async () => {
    const other = asset("clip", { commercialUse: null, metadata: { role: "scene" } });
    expect(await find(other)).toBeUndefined();
  });
  it("finds a clip handed in directly", async () => {
    expect((await find(clip(null), clip(null)))?.id).toBe("clip");
  });
});
