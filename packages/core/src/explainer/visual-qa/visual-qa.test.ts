import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE } from "../explainer-context.js";
import {
  STYLE_FRAME_CAPTION_WORDS,
  STYLE_FRAME_CAST,
  STYLE_FRAME_SHOTS,
  styleFrameScene,
  styleFrameStoryboard,
  styleFrameTiming,
} from "../fixtures/style-frames/fixtures.js";
import { planMotion } from "../motion/plan.js";
import type { SceneSpec } from "../scene-spec.js";
import { type FrameMetrics, frameFindings, keyFrameMs, stripFindings } from "./frame-findings.js";
import {
  actorBox,
  captionBox,
  cropFraction,
  outsideSafeBox,
  overlayBox,
  planFindings,
  sceneSpecFindings,
} from "./scene-graph.js";
import { blockReasons } from "./tunables.js";

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture missing");
  return value;
};

const keys = STYLE_FRAME_CAST.map((character) => character.key);
const planFor = (index: number) => {
  const shot = STYLE_FRAME_SHOTS[index];
  if (!shot) throw new Error("fixture");
  return planMotion({
    scenes: [styleFrameScene(shot)],
    timings: [styleFrameTiming(shot)],
    characters: STYLE_FRAME_CAST,
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: STYLE_FRAME_CAPTION_WORDS,
    durationMs: shot.durationMs,
  });
};

describe("scene-graph checks", () => {
  it("measures how much of a box is outside the frame", () => {
    expect(cropFraction({ left: 100, top: 100, right: 300, bottom: 500 })).toBe(0);
    expect(cropFraction({ left: -100, top: 100, right: 100, bottom: 500 })).toBeCloseTo(0.5);
    expect(cropFraction({ left: -150, top: 100, right: 50, bottom: 500 })).toBeGreaterThan(0.4);
  });

  it("flags text outside SAFE_BOX beyond the slack only", () => {
    expect(outsideSafeBox({ left: 130, top: 400, right: 860, bottom: 480 })).toBe(false);
    expect(outsideSafeBox({ left: 130, top: 400, right: 960, bottom: 480 })).toBe(true);
    expect(outsideSafeBox({ left: 130, top: 150, right: 860, bottom: 230 })).toBe(true);
  });

  it("keeps the fixture storyboard free of BLOCK findings", () => {
    const { scenes } = styleFrameStoryboard();
    expect(blockReasons(sceneSpecFindings({ scenes, characterKeys: keys }))).toEqual([]);
  });

  it("blocks unknown catalog ids with the scene index", () => {
    const scene = styleFrameScene(must(STYLE_FRAME_SHOTS[0]));
    const broken: SceneSpec = {
      ...scene,
      actors: [{ ...must(scene.actors[0]), characterKey: "ghost" }],
    };
    expect(sceneSpecFindings({ scenes: [broken], characterKeys: keys })).toContainEqual({
      id: "catalog_ref_invalid",
      severity: "BLOCK",
      sceneIndex: 1,
    });
  });

  it("warns, never blocks, on a repeated composition and on an estimated overlap", () => {
    const scene = styleFrameScene(must(STYLE_FRAME_SHOTS[0]));
    const scenes = [1, 2, 3].map((index) => ({ ...scene, index }));
    const found = sceneSpecFindings({ scenes, characterKeys: keys });
    expect(found.map((entry) => entry.id)).toContain("composition_repeated");
    const overlapping: SceneSpec = {
      ...scene,
      overlays: [{ text: "Sobre o ator", position: "middle", emphasis: true }],
    };
    const overlap = sceneSpecFindings({ scenes: [overlapping], characterKeys: keys });
    expect(overlap.find((entry) => entry.id === "actor_text_overlap_estimate")?.severity).toBe(
      "WARN",
    );
    expect(blockReasons(found)).toEqual([]);
    expect(actorBox(scene, must(scene.actors[0])).bottom).toBe(1180);
  });

  it("blocks a timeline that overlaps or leaves the render and warns on a long dead hold", () => {
    const plan = planFor(0);
    expect(planFindings(plan)).toEqual([]);
    const scene = must(plan.scenes[0]);
    const late = { ...plan, scenes: [{ ...scene, endMs: plan.durationMs + 5_000 }] };
    expect(blockReasons(planFindings(late))).toEqual(["timeline_invalid"]);
    const overlapped = { ...plan, scenes: [scene, { ...scene, startMs: 0 }] };
    expect(blockReasons(planFindings(overlapped))).toEqual(["timeline_invalid"]);
    const dead = {
      ...plan,
      durationMs: 10_000,
      scenes: [{ ...scene, endMs: 9_000, overlays: [], actors: [] }],
    };
    expect(planFindings(dead).map((entry) => entry.id)).toEqual(["long_hold"]);
  });

  it("places the key frame after the cut settled and inside the scene", () => {
    const plan = planFor(0);
    const t = keyFrameMs(plan, 0);
    expect(t).toBeGreaterThanOrEqual(400);
    expect(t).toBeLessThan(must(plan.scenes[0]).endMs);
  });

  it("estimates a caption box inside SAFE_BOX for short words", () => {
    expect(outsideSafeBox(captionBox(planFor(0), "Esse aqui é").box)).toBe(false);
  });
});

const metrics = (over: Partial<FrameMetrics> = {}): FrameMetrics => ({
  actorAreaPct: 10,
  actorCentroid: { x: 0.5, y: 0.45 },
  focalContrast: 0.4,
  accentShare: 0.05,
  valueTiers: [0.15, 0.25, 0.6],
  dominantArea: 0.3,
  secondaryArea: 0.1,
  meanHex: "#808080",
  texts: [],
  ...over,
});
const captionText = (plan: ReturnType<typeof planFor>) => captionBox(plan, "Esse aqui é");

describe("frame findings", () => {
  const plan = planFor(0);
  it("blocks low caption contrast against the measured background", () => {
    // Plate is ink (#161616) at 0.88 over mid grey: white text passes; a light plate does not.
    const ok = frameFindings({
      metrics: metrics({ texts: [{ text: captionText(plan), actorOverlap: 0, bgHex: "#808080" }] }),
      plan,
      sceneIndex: 0,
      hook: false,
    });
    expect(blockReasons(ok)).toEqual([]);
    const light = {
      ...plan,
      palette: { ...plan.palette, line: "#F0F0F0" },
    };
    const bad = frameFindings({
      metrics: metrics({
        texts: [{ text: captionText(light), actorOverlap: 0, bgHex: "#F0F0F0" }],
      }),
      plan: light,
      sceneIndex: 0,
      hook: false,
    });
    expect(blockReasons(bad)).toEqual(["caption_contrast"]);
  });

  it("blocks a severe actor and text collision, names it, and leaves WARNs as WARN", () => {
    const overlay = overlayBox({ text: "Sobre o ator", position: "middle", emphasis: true });
    const found = frameFindings({
      metrics: metrics({
        actorAreaPct: 60,
        accentShare: 0,
        texts: [
          { text: overlay, actorOverlap: 0.21, bgHex: "#808080" },
          { text: captionText(plan), actorOverlap: 0.9, bgHex: "#808080" },
        ],
      }),
      plan,
      sceneIndex: 0,
      hook: true,
    });
    expect(blockReasons(found)).toEqual(["actor_text_collision"]);
    expect(found.map((entry) => entry.id)).toContain("actor_caption_overlap");
    expect(found.filter((entry) => entry.severity === "WARN").map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["hero_area", "accent_missing"]),
    );
  });

  it("does not block at exactly the collision limit", () => {
    const found = frameFindings({
      metrics: metrics({
        texts: [
          {
            text: overlayBox({ text: "Sobre", position: "top" }),
            actorOverlap: 0.2,
            bgHex: "#808080",
          },
        ],
      }),
      plan,
      sceneIndex: 0,
      hook: false,
    });
    expect(blockReasons(found)).toEqual([]);
  });
});

describe("colour strip", () => {
  it("warns on monotony and on hue walks, and ignores short strips", () => {
    expect(stripFindings(["#808080", "#808080"])).toEqual([]);
    expect(stripFindings(["#808080", "#828282", "#7e7e7e"]).map((f) => f.id)).toEqual([
      "colour_monotony",
    ]);
    expect(stripFindings(["#ff0000", "#00c0ff", "#ff0000"]).map((f) => f.id)).toContain(
      "colour_hue_walk",
    );
    expect(stripFindings(["#d04030", "#c05a40", "#d08050"])).toEqual([]);
  });
});
