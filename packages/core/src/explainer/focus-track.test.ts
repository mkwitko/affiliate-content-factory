import { describe, expect, it } from "vitest";
import type { SceneSpec } from "./scene-spec.js";
import { focusTrack, sceneFocusX } from "./focus-track.js";

const scenes = [
  { startMs: 0, endMs: 4000, focusX: 0.25 },
  { startMs: 4000, endMs: 8000, focusX: 0.75 },
  { startMs: 8000, endMs: 12_000, focusX: 0.75 },
  { startMs: 12_000, endMs: 15_000 },
];

describe("focusTrack", () => {
  it("returns null when no scene has a focus", () => {
    expect(
      focusTrack({ scenes: [{ startMs: 0, endMs: 1000 }], sourceWidth: 1920, sourceHeight: 1080 }),
    ).toBeNull();
  });

  it("uses a 9:16 window of even width and snaps at scene cuts", () => {
    const track = focusTrack({ scenes, sourceWidth: 1920, sourceHeight: 1080 });
    expect(track?.cropWidth).toBe(608);
    // 0.25 * 1920 - 304 = 176; 0.75 * 1920 - 304 = 1136; no focus -> centre 960 - 304 = 656.
    expect(track?.points).toEqual([
      { tMs: 0, x: 176 },
      { tMs: 4000, x: 1136 },
      { tMs: 12_000, x: 656 },
    ]);
  });

  it("does not move inside a scene and never repeats an unchanged position", () => {
    const track = focusTrack({ scenes, sourceWidth: 1920, sourceHeight: 1080 });
    expect(track?.points.filter((p) => p.tMs > 4000 && p.tMs < 12_000)).toHaveLength(0);
  });

  it("clamps the window to the frame", () => {
    const track = focusTrack({
      scenes: [
        { startMs: 0, endMs: 1000, focusX: 0 },
        { startMs: 1000, endMs: 2000, focusX: 1 },
      ],
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(track?.points.map((p) => p.x)).toEqual([0, 1920 - 608]);
  });
});

describe("sceneFocusX", () => {
  const spec = (actors: SceneSpec["actors"]) => ({ actors }) as unknown as SceneSpec;
  it("reads the first actor's stage position from a stored SceneSpec", () => {
    const actor = (position: "left" | "center" | "right") =>
      ({ position }) as SceneSpec["actors"][number];
    expect(sceneFocusX(spec([actor("left"), actor("right")]))).toBeCloseTo(300 / 1080);
    expect(sceneFocusX(spec([actor("right")]))).toBeCloseTo(780 / 1080);
  });
  it("has no focus for a slideshow scene or a scene without actors", () => {
    expect(sceneFocusX({ assetId: "a", motion: "static" } as never)).toBeUndefined();
    expect(sceneFocusX(spec([]))).toBeUndefined();
  });
});
