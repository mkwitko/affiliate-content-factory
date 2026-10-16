import { describe, expect, it } from "vitest";
import {
  COMPOSITING_HYPOTHESIS,
  DEFAULT_COMPOSITING,
  HALO_BAND,
  hexChroma,
  isNeutralCompositing,
  lightVector,
  platePostProcessPlan,
  readCompositingProfile,
} from "./compositing.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import { composeMotionFrame } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import type { SceneSpec } from "./scene-spec.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  wardrobe: { top: { style: "hoodie", colour: "#2f6fdb" } },
};
const scene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  index: 1,
  fromChar: 0,
  toChar: 10,
  purpose: "hook",
  background: "store",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "left" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "pan_right" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const timing: MotionSceneTiming = {
  startMs: 0,
  endMs: 3_000,
  voiceStartMs: 200,
  voiceEndMs: 2_600,
  text: "Why is milk at the back",
  words: ["Why", "is", "milk", "at", "the", "back"].map((text, i) => ({
    text,
    startMs: 200 + i * 400,
    endMs: 550 + i * 400,
  })),
};
const frame = (
  compositing?: typeof DEFAULT_COMPOSITING,
  over: Partial<SceneSpec> = {},
  art = false,
) =>
  composeMotionFrame(
    planMotion({
      scenes: [scene({ ...over, ...(art ? { backgroundAssetId: "bg" } : {}) })],
      timings: [timing],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 3_000,
      ...(art ? { backgroundArt: new Map([["bg", { href: "data:image/png;base64,AA==" }]]) } : {}),
      ...(compositing ? { compositing } : {}),
    }),
    1_500,
  );

describe("readCompositingProfile", () => {
  it("returns null without a stored profile, so the render path stays untouched", () => {
    expect(readCompositingProfile(undefined)).toBeNull();
    expect(readCompositingProfile("x")).toBeNull();
  });

  it("resolves a partial profile against the default and drops out-of-range values", () => {
    const profile = readCompositingProfile({
      depth: { far: 0.2, mid: 9 },
      lighting: { shadowOffset: [12, "x"] },
      rim: { enabled: true, colour: "#ffffff" },
    });
    expect(profile?.depth).toEqual({ ...DEFAULT_COMPOSITING.depth, far: 0.2 });
    expect(profile?.lighting.shadowOffset).toEqual([12, 0]);
    expect(profile?.rim).toEqual({ enabled: true, widthPx: 4, colour: "#ffffff" });
    expect(readCompositingProfile({})).toEqual(DEFAULT_COMPOSITING);
  });
});

describe("compositing in the composer", () => {
  it("draws byte-identical frames with the default profile, with and without a plate", () => {
    expect(isNeutralCompositing(DEFAULT_COMPOSITING)).toBe(true);
    expect(frame(DEFAULT_COMPOSITING)).toBe(frame());
    expect(frame(DEFAULT_COMPOSITING, {}, true)).toBe(frame(undefined, {}, true));
  });

  it("moves the painted plate by the far depth", () => {
    const shallow = frame(
      { ...DEFAULT_COMPOSITING, depth: { ...DEFAULT_COMPOSITING.depth, far: 0.2 } },
      {},
      true,
    );
    expect(shallow).not.toBe(frame(undefined, {}, true));
    expect(shallow).toContain('data-art="1"');
  });

  it("draws the procedural setting as its own mid layer when mid differs from the stage", () => {
    const svg = frame({
      ...DEFAULT_COMPOSITING,
      depth: { ...DEFAULT_COMPOSITING.depth, mid: 0.6 },
    });
    expect(svg).toContain('data-layer="mid"');
    expect(frame(DEFAULT_COMPOSITING)).not.toContain('data-layer="mid"');
  });

  it("offsets and strengthens the contact shadow from the lighting", () => {
    const svg = frame({
      ...DEFAULT_COMPOSITING,
      lighting: { directionDeg: 315, shadowStrength: 2, shadowOffset: [18, 4] },
    });
    expect(svg).toContain('cx="18" cy="10"');
    expect(svg).toContain('fill-opacity="0.18"');
  });

  it("draws a rim silhouette in the rim colour behind the actor, clothes included", () => {
    const svg = frame({ ...DEFAULT_COMPOSITING, rim: { enabled: true, widthPx: 5 } });
    expect(svg).toContain("#FFF6E0");
    expect(svg.indexOf("#FFF6E0")).toBeLessThan(svg.indexOf("#2f6fdb"));
    expect(frame(DEFAULT_COMPOSITING)).not.toContain("#FFF6E0");
  });

  it("keeps the research preset stable", () => {
    expect(frame(COMPOSITING_HYPOTHESIS, {}, true)).toMatchSnapshot();
  });
});

describe("plate post-process plan", () => {
  it("caps chroma relative to the accent and maps the actor band onto the plate", () => {
    const plan = platePostProcessPlan(COMPOSITING_HYPOTHESIS, DEFAULT_SCENE_PALETTE);
    expect(plan.maxMeanChroma).toBeCloseTo(0.6 * hexChroma("#FF5A36"), 6);
    expect(hexChroma("#FF5A36")).toBeGreaterThan(0.15);
    expect(hexChroma("#808080")).toBeLessThan(0.001);
    expect(plan).toMatchObject({ farValuePull: 0.3, blurSigma: 1.5, pullTarget: "#F6F1E7" });
    expect(HALO_BAND.top).toBeGreaterThan(0.1);
    expect(HALO_BAND.bottom).toBeLessThan(0.7);
    expect(HALO_BAND.top).toBeLessThan(HALO_BAND.bottom);
  });

  it("points the light vector at the key light", () => {
    const top = lightVector(DEFAULT_COMPOSITING);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-1);
    expect(lightVector(COMPOSITING_HYPOTHESIS).x).toBeLessThan(0);
  });
});
