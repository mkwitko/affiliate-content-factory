import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { composeSceneSvg } from "@money-maker/core/explainer/compose-scene";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import { SAFE_BOX } from "@money-maker/core/explainer/layout";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { rasterizeSvg } from "./svg-rasterizer.js";

// Measures real glyph extents (Inter via fontconfig), not an estimate.
const inkColumns = async (png: Uint8Array, top: number, bottom: number) => {
  const { data, info } = await sharp(Buffer.from(png)).raw().toBuffer({ resolveWithObject: true });
  let min = info.width;
  let max = -1;
  for (let y = top; y < bottom; y += 1)
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if ((data[i] ?? 255) < 90 && (data[i + 1] ?? 255) < 90 && (data[i + 2] ?? 255) < 90) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
  return { min, max };
};

const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 1,
  purpose: "hook",
  background: "plain",
  actors: [],
  props: [],
  overlays: [{ text: "HOW BANKS REALLY PROFIT!", emphasis: true, position: "top" }],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
};

describe("scene text fits the safe box", () => {
  it("keeps a 24-character emphasis overlay inside the safe box", async () => {
    const png = await rasterizeSvg(
      composeSceneSvg(scene, { characters: [], palette: DEFAULT_SCENE_PALETTE }),
      { width: 1080, height: 1920 },
    );
    const { min, max } = await inkColumns(png, 300, 440);
    expect(max).toBeGreaterThan(min);
    expect(min).toBeGreaterThanOrEqual(SAFE_BOX.left);
    expect(max).toBeLessThanOrEqual(SAFE_BOX.right);
  });
});
