import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Asset } from "../assets/asset.js";
import {
  ambientLoopPrompt,
  ambientLoopVerdict,
  EXPLAINER_ART_STYLES,
  isUsableLoop,
  readGenerationProvenance,
  explainerBackgroundKey,
  explainerBackgroundPrompt,
  explainerBackgroundRequest,
} from "./background-art.js";
import { BACKGROUNDS } from "./backgrounds.js";

describe("explainer background prompts", () => {
  it("locks the style, the empty stage and the no-people/no-text rules into every prompt", () => {
    for (const style of EXPLAINER_ART_STYLES)
      for (const setting of BACKGROUNDS) {
        const prompt = explainerBackgroundPrompt({
          setting,
          style,
          paletteHint: "warm terracotta",
        });
        expect(prompt).toContain("empty open floor across the lower third as a stage");
        expect(prompt).toContain("no people, no characters, no animals, no text");
        expect(prompt).toContain("no logos, no products");
        expect(prompt).toContain("warm terracotta palette");
      }
    expect(
      explainerBackgroundPrompt({ setting: "kitchen", style: "flat_cartoon", paletteHint: "x" }),
    ).toContain("clean flat 2D cartoon");
    expect(
      explainerBackgroundPrompt({
        setting: "kitchen",
        style: "sketch_watercolor",
        paletteHint: "x",
      }),
    ).toContain("watercolor");
  });

  it("versions bank keys by niche, setting and style and asks for a portrait image", () => {
    expect(explainerBackgroundKey("n1", { setting: "bank", style: "sketch_watercolor" })).toBe(
      "n1:explainer:bank:sketch_watercolor:v1",
    );
    expect(
      explainerBackgroundRequest("n1", {
        setting: "bank",
        style: "flat_cartoon",
        paletteHint: "navy",
      }),
    ).toMatchObject({
      role: "explainer_background",
      key: "n1:explainer:bank:flat_cartoon:v1",
      poolMin: 2,
      size: { width: 768, height: 1344 },
      metadata: { setting: "bank", style: "flat_cartoon", promptVersion: 1 },
    });
  });
});

describe("ambient loops", () => {
  const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
  const generation = {
    model: "local:wan2.2-ti2v-5b",
    weightsLicense: "Apache-2.0",
    tool: "sd.cpp master-4a1b",
    seed: 1234,
    prompt: "a home kitchen, static camera",
  };
  const loop: Asset = {
    id: "loop-1",
    workspaceId,
    objectKey: "k",
    checksum: "c",
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 2_000,
    provenance: "generated",
    commercialUse: true,
    license: "Apache-2.0 (local:wan2.2-ti2v-5b, local)",
    creator: "local:wan2.2-ti2v-5b",
    state: "active",
    metadata: {
      role: "ambient_loop",
      backgroundAssetId: "bg-1",
      qa: { verdict: "pass" },
      generation,
    },
  };

  it("passes seamless moving loops and blocks seams, freezes and bad lengths (measured fixtures)", () => {
    expect(ambientLoopVerdict({ durationMs: 2_000, motion: 4.62, seam: 4.53 })).toEqual({
      verdict: "pass",
    });
    expect(ambientLoopVerdict({ durationMs: 1_500, motion: 3.1, seam: 5.05 })).toEqual({
      verdict: "pass",
    });
    expect(ambientLoopVerdict({ durationMs: 2_000, motion: 2.32, seam: 88.98 })).toEqual({
      verdict: "block",
      reason: "loop_seam",
    });
    expect(ambientLoopVerdict({ durationMs: 2_000, motion: 0, seam: 0 })).toEqual({
      verdict: "block",
      reason: "loop_frozen",
    });
    for (const durationMs of [500, 6_500])
      expect(ambientLoopVerdict({ durationMs, motion: 4, seam: 4 })).toEqual({
        verdict: "block",
        reason: "loop_duration",
      });
  });

  it("requires model, weights licence, tool, seed and prompt as provenance", () => {
    expect(readGenerationProvenance(generation)).toEqual(generation);
    expect(readGenerationProvenance({ ...generation, promptVersion: 1 })).toMatchObject({
      promptVersion: 1,
    });
    for (const bad of [
      { ...generation, seed: -1 },
      { ...generation, seed: 1.5 },
      { ...generation, tool: "" },
      { ...generation, weightsLicense: undefined },
      "local:wan2.2-ti2v-5b",
    ])
      expect(readGenerationProvenance(bad)).toBeNull();
  });

  it("uses a loop only when it is QA-passed, licensed, provenanced and attached to that background", () => {
    expect(isUsableLoop(loop, workspaceId, "bg-1")).toBe(true);
    expect(isUsableLoop(loop, workspaceId, "bg-2")).toBe(false);
    for (const bad of [
      { ...loop, commercialUse: null },
      { ...loop, state: "archived" as const },
      { ...loop, mimeType: "image/png" },
      { ...loop, durationMs: 9_000 },
      { ...loop, metadata: { ...loop.metadata, qa: { verdict: "block" } } },
      { ...loop, metadata: { ...loop.metadata, generation: { model: "local:wan2.2-ti2v-5b" } } },
    ])
      expect(isUsableLoop(bad, workspaceId, "bg-1")).toBe(false);
  });

  it("asks loop generators for background-only ambient motion with a static camera", () => {
    const prompt = ambientLoopPrompt({
      setting: "kitchen",
      style: "flat_cartoon",
      paletteHint: "warm",
    });
    expect(prompt).toContain("no people, no characters");
    expect(prompt).toContain("static camera");
  });
});
