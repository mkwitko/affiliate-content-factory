import { describe, expect, it } from "vitest";
import {
  LOCATION_PLATE_SIZE,
  locationPlateKey,
  locationPlateRequest,
  plateBox,
} from "./background-art.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import { OFFICE_LOCATION } from "./fixtures/cast/location-fixture.js";
import { readLocations } from "./locations.js";
import { composeMotionFrame } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import type { SceneSpec } from "./scene-spec.js";

const locations = readLocations([OFFICE_LOCATION]);
const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const timing: MotionSceneTiming = {
  startMs: 0,
  endMs: 2_000,
  voiceStartMs: 200,
  voiceEndMs: 1_800,
  text: "a b c",
  words: ["a", "b", "c"].map((text, i) => ({ text, startMs: 200 + i * 500, endMs: 600 + i * 500 })),
};
const scene = (over: Partial<SceneSpec>): SceneSpec => ({
  index: 1,
  fromChar: 0,
  toChar: 5,
  purpose: "hook",
  background: "office",
  backgroundAssetId: "plate-office",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "left" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "none",
  ...over,
});
const plan = (over: Partial<SceneSpec>, seed?: string, withLocations = true) =>
  planMotion({
    scenes: [scene(over)],
    timings: [timing],
    characters: [alex],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: 2_000,
    backgroundArt: new Map([["plate-office", { href: "data:image/png;base64,AA==" }]]),
    ...(withLocations ? { locations } : {}),
    ...(seed ? { variationSeed: seed } : {}),
  });

describe("location plate bank", () => {
  it("keys plates by location, style and template version", () => {
    expect(locationPlateKey("n1", { locationId: "office_a", style: "flat_cartoon" })).toBe(
      "n1:location:office_a:flat_cartoon:t1",
    );
    const request = locationPlateRequest("n1", {
      locationId: "office_a",
      name: "Escritório",
      setting: "office",
      style: "sketch_watercolor",
      paletteHint: "warm",
    });
    expect(request).toMatchObject({
      poolMin: 1,
      size: LOCATION_PLATE_SIZE,
      metadata: { locationId: "office_a", promptTemplateVersion: 1 },
    });
    expect(request.prompt).toContain("no people");
    expect(request.key).not.toBe(
      locationPlateKey("n1", { locationId: "market_a", style: "sketch_watercolor" }),
    );
  });

  it("uses the spec's 2.2 x 1.4 overscan box", () => {
    const box = plateBox(2.2);
    expect(box.width / 1200).toBeCloseTo(2.2);
    expect(box.height / 2132).toBeCloseTo(1.4);
    expect(plateBox(1)).toMatchObject({ width: 1200, height: 2132 });
  });
});

describe("plate framing", () => {
  it("leaves scenes without a location, or renders without locations, as before", () => {
    expect(plan({}).scenes[0]?.plate).toBeUndefined();
    expect(composeMotionFrame(plan({ locationId: "office_a" }, undefined, false), 600)).toBe(
      composeMotionFrame(plan({}), 600),
    );
  });

  it("crops by zone, varies by seed deterministically and tints by lighting", () => {
    const desk = plan({ locationId: "office_a", zoneId: "desk" }, "board-1").scenes[0]?.plate;
    expect(plan({ locationId: "office_a", zoneId: "desk" }, "board-1").scenes[0]?.plate).toEqual(
      desk,
    );
    const other = plan({ locationId: "office_a", zoneId: "desk" }, "board-2").scenes[0]?.plate;
    expect(other).not.toEqual(desk);
    expect(Math.abs((desk?.cx ?? 0) - 0.35)).toBeLessThanOrEqual(0.06 + 1e-9);
    expect(desk?.zoom).toBeGreaterThanOrEqual(1.1);
    expect(desk?.zoom).toBeLessThanOrEqual(1.1 * 1.15 + 1e-9);
    const night = plan({ locationId: "office_a", zoneId: "desk", lighting: "night" }, "board-1")
      .scenes[0]?.plate;
    expect(night?.grade).toEqual({ tint: "#1d2a5a", alpha: 0.45 });
  });

  it("keeps the crop inside the plate so it always covers the frame", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const plate = plan({ locationId: "office_a", zoneId: "door" }, seed).scenes[0]?.plate;
      if (!plate) throw new Error("no plate");
      const halfW = (540 / (plate.box.width * plate.zoom)) * 1.12;
      expect(plate.cx).toBeGreaterThanOrEqual(halfW - 1e-3);
    }
  });
});
