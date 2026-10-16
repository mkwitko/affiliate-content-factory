import { describe, expect, it } from "vitest";
import { BACKGROUND_ART_BOX } from "./background-art.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import {
  BASELINE_Y,
  CAPTION_BAND,
  FRAME,
  geometryFor,
  LANDSCAPE_GEOMETRY,
  PORTRAIT_GEOMETRY,
  positionX,
  SAFE_BOX,
} from "./layout.js";
import {
  captionRect,
  headBand,
  LANDSCAPE_LAYOUTS,
  LAYOUT_IDS,
  LAYOUTS,
  type Rect,
  rectsOverlap,
} from "./layouts.js";
import { readLocations, resolveLocationScene } from "./locations.js";
import { composeSceneSvg } from "./compose-scene.js";
import { composeMotionFrame, vignetteMaskSvg } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import type { SceneSpec } from "./scene-spec.js";
import type { ShotKind } from "./shots.js";
import {
  actorBox,
  captionBox,
  cropFraction,
  outsideSafeBox,
  overlayBox,
  sceneSpecFindings,
} from "./visual-qa/scene-graph.js";
import { frameFindings, type FrameMetrics } from "./visual-qa/frame-findings.js";
import { blockReasons } from "./visual-qa/tunables.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const base: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 20,
  purpose: "hook",
  background: "office",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "center" }],
  props: [],
  overlays: [{ text: "WHY IS MILK AT THE BACK?", position: "top", emphasis: true }],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
};
const timing: MotionSceneTiming = {
  startMs: 0,
  endMs: 2_400,
  voiceStartMs: 200,
  voiceEndMs: 2_000,
  text: "Why is milk at the back",
  words: ["Why", "is", "milk", "at", "the", "back"].map((text, i) => ({
    text,
    startMs: 200 + i * 300,
    endMs: 200 + i * 300 + 260,
  })),
};
const planFor = (scene: SceneSpec, canvas?: "landscape") =>
  planMotion({
    scenes: [scene],
    timings: [timing],
    characters: [alex],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: timing.endMs,
    ...(canvas ? { canvas } : {}),
  });

const px = (r: Rect, geo = LANDSCAPE_GEOMETRY) => ({
  left: r.x * geo.frame.width,
  right: (r.x + r.w) * geo.frame.width,
  top: r.y * geo.frame.height,
  bottom: (r.y + r.h) * geo.frame.height,
});

describe("canvas geometry", () => {
  it("keeps portrait exactly the legacy constants", () => {
    expect(PORTRAIT_GEOMETRY.frame).toEqual(FRAME);
    expect(PORTRAIT_GEOMETRY.safeBox).toEqual(SAFE_BOX);
    expect(PORTRAIT_GEOMETRY.captionBand).toEqual(CAPTION_BAND);
    expect(PORTRAIT_GEOMETRY.baselineY).toBe(BASELINE_Y);
    expect(PORTRAIT_GEOMETRY.artBox).toEqual(BACKGROUND_ART_BOX);
    expect(geometryFor(undefined)).toBe(PORTRAIT_GEOMETRY);
    expect(geometryFor("landscape")).toBe(LANDSCAPE_GEOMETRY);
  });

  it("gives landscape its own 1920x1080 safe area, caption band and ground line", () => {
    const g = LANDSCAPE_GEOMETRY;
    expect(g.frame).toEqual({ width: 1920, height: 1080 });
    expect(g.captionBand.top).toBeGreaterThanOrEqual(g.safeBox.top);
    expect(g.captionBand.bottom).toBeLessThanOrEqual(g.safeBox.bottom);
    // Feet (baseline + 30 px of line) stand above the caption band.
    expect(g.baselineY + 30).toBeLessThan(g.captionBand.top);
    for (const x of Object.values(g.stageX)) {
      expect(x - 130).toBeGreaterThanOrEqual(g.safeBox.left);
      expect(x + 130).toBeLessThanOrEqual(g.safeBox.right);
    }
    expect([positionX("left", g), positionX("center", g), positionX("right", g)]).toEqual([
      420, 960, 1500,
    ]);
  });
});

describe("landscape layouts", () => {
  it("has slot geometry for every layout id", () => {
    expect(Object.keys(LANDSCAPE_LAYOUTS).sort()).toEqual([...LAYOUT_IDS].sort());
    for (const id of LAYOUT_IDS) {
      expect(LANDSCAPE_LAYOUTS[id].actorSlots).toEqual(LAYOUTS[id].actorSlots);
      expect(LANDSCAPE_LAYOUTS[id].minActors).toBe(LAYOUTS[id].minActors);
    }
  });

  it("keeps actors and text inside the safe area and off the caption band", () => {
    const g = LANDSCAPE_GEOMETRY;
    const caption = captionRect(g);
    for (const layout of Object.values(LANDSCAPE_LAYOUTS)) {
      const rects = [layout.textRect, layout.propRect, layout.diagramRect].flatMap((r) =>
        r ? [r] : [],
      );
      for (const r of [...layout.actorRects, ...rects]) {
        const box = px(r);
        expect(box.left, layout.id).toBeGreaterThanOrEqual(g.safeBox.left);
        expect(box.right, layout.id).toBeLessThanOrEqual(g.safeBox.right + 1e-6);
        expect(box.top, layout.id).toBeGreaterThanOrEqual(g.safeBox.top);
        expect(rectsOverlap(r, caption), layout.id).toBe(false);
      }
      // Text clears every actor, prop and diagram slot.
      if (layout.textRect) {
        for (const other of [
          ...layout.actorRects,
          ...[layout.propRect, layout.diagramRect].flatMap((r) => (r ? [r] : [])),
        ])
          expect(rectsOverlap(layout.textRect, other), layout.id).toBe(false);
        for (const actor of layout.actorRects)
          expect(rectsOverlap(layout.textRect, headBand(actor)), layout.id).toBe(false);
      }
      // Actors clear the diagram and each other.
      if (layout.diagramRect)
        for (const actor of layout.actorRects)
          expect(rectsOverlap(layout.diagramRect, actor), layout.id).toBe(false);
      layout.actorRects.forEach((a, i) => {
        for (const b of layout.actorRects.slice(i + 1))
          expect(rectsOverlap(a, b), layout.id).toBe(false);
      });
    }
  });

  it("makes close shots visibly closer than medium and wide", () => {
    const g = LANDSCAPE_GEOMETRY;
    const heightOf = (shot: ShotKind) => {
      const scene: SceneSpec = { ...base, camera: { shot, movement: "none" } };
      const actor = scene.actors[0];
      if (!actor) throw new Error("fixture");
      const box = actorBox(scene, actor, g);
      expect(box.top, shot).toBeGreaterThanOrEqual(g.safeBox.top);
      expect(box.bottom + 30, shot).toBeLessThan(g.captionBand.top);
      return box.bottom - box.top;
    };
    const [wide, medium, close] = [heightOf("wide"), heightOf("medium"), heightOf("close")];
    expect(close).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(wide);
    expect(close / wide).toBeGreaterThan(1.5);
    // The top overlay line clears even the close actor's head.
    const closeScene: SceneSpec = { ...base, camera: { shot: "close", movement: "none" } };
    const actor = closeScene.actors[0];
    const overlay = closeScene.overlays[0];
    if (!actor || !overlay) throw new Error("fixture");
    expect(overlayBox(overlay, g).box.bottom).toBeLessThan(actorBox(closeScene, actor, g).top);
  });
});

describe("landscape frames", () => {
  it("composes a 1920x1080 frame and leaves the portrait frame at 1080x1920", () => {
    const landscape = composeMotionFrame(planFor(base, "landscape"), 1_000);
    expect(landscape).toContain('width="1920" height="1080" viewBox="0 0 1920 1080"');
    const portrait = composeMotionFrame(planFor(base), 1_000);
    expect(portrait).toContain('width="1080" height="1920" viewBox="0 0 1080 1920"');
    expect(vignetteMaskSvg("landscape")).toContain('width="1920" height="1080"');
    expect(
      composeSceneSvg(base, {
        characters: [alex],
        palette: DEFAULT_SCENE_PALETTE,
        canvas: "landscape",
      }),
    ).toContain('viewBox="0 0 1920 1080"');
  });

  it("draws the caption plate inside the landscape caption band, centred", () => {
    const plan = planFor(base, "landscape");
    const frame = composeMotionFrame(plan, 1_000);
    const plate = frame.match(
      /<g data-caption="1"[^>]*><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/,
    );
    if (!plate) throw new Error("caption missing");
    const [x, y, w, h] = plate.slice(1).map(Number) as [number, number, number, number];
    const g = LANDSCAPE_GEOMETRY;
    expect(y).toBeGreaterThanOrEqual(g.captionBand.top);
    expect(y + h).toBeLessThanOrEqual(g.captionBand.bottom);
    expect(x).toBeGreaterThanOrEqual(g.safeBox.left);
    expect(x + w).toBeLessThanOrEqual(g.safeBox.right);
    expect(x + w / 2).toBeCloseTo(960, 0);
    expect(outsideSafeBox(captionBox(plan, "Why is milk at the back?").box, g)).toBe(false);
  });

  it("keeps a walk-in actor entering from outside the landscape frame", () => {
    const walker: SceneSpec = {
      ...base,
      actors: [
        {
          characterKey: "alex",
          pose: "neutral",
          expression: "neutral",
          position: "right",
          actions: [{ type: "enter", atWord: 0, from: "right", durationMs: 900 }],
        },
      ],
    };
    const plan = planFor(walker, "landscape");
    const action = plan.scenes[0]?.actors[0]?.actions[0];
    expect(action?.fromX).toBe(LANDSCAPE_GEOMETRY.offstageX.right);
    expect(action?.toX).toBe(1500);
  });
});

describe("landscape location plates", () => {
  const locations = readLocations([
    {
      id: "office_a",
      name: "Escritório",
      plate: { assetId: "plate-office", overscan: 2.2 },
      proceduralFallback: "office",
      zones: [
        {
          id: "desk",
          crop: { cx: 0.4, cy: 0.5, zoom: 1.1 },
          allowedShots: ["medium"],
          maxActors: 2,
        },
      ],
      anchors: [{ id: "mid", x: 0.38, facing: "right" }],
    },
  ]);

  it("maps anchor fractions onto the landscape stage columns", () => {
    const scene: SceneSpec = {
      ...base,
      locationId: "office_a",
      zoneId: "desk",
      actors: [
        {
          characterKey: "alex",
          pose: "neutral",
          expression: "neutral",
          position: "left",
          anchorId: "mid",
        },
      ],
    };
    const place = (canvas?: "landscape") => {
      const resolved = resolveLocationScene(scene, locations, canvas);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.scene.actors[0]?.position;
    };
    expect(place()).toBe("left");
    expect(place("landscape")).toBe("center");
  });

  it("crops the zone so the plate always covers the landscape frame", () => {
    const scene: SceneSpec = { ...base, locationId: "office_a", zoneId: "desk" };
    const resolved = resolveLocationScene(scene, locations, "landscape");
    if (!resolved.ok) throw new Error(resolved.reason);
    const withArt = planMotion({
      scenes: [resolved.scene],
      timings: [timing],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timing.endMs,
      canvas: "landscape",
      locations,
      backgroundArt: new Map([["plate-office", { href: "data:image/png;base64,AA==" }]]),
    });
    const plate = withArt.scenes[0]?.plate;
    if (!plate) throw new Error("plate missing");
    const { box, cx, cy, zoom } = plate;
    expect(box.x + box.width / 2).toBeCloseTo(960, 0);
    expect(box.y + box.height / 2).toBeCloseTo(540, 0);
    // The visible window (frame / zoom around the crop centre) stays inside the plate.
    const halfW = 960 / zoom / box.width;
    const halfH = 540 / zoom / box.height;
    expect(cx - halfW).toBeGreaterThanOrEqual(0);
    expect(cx + halfW).toBeLessThanOrEqual(1);
    expect(cy - halfH).toBeGreaterThanOrEqual(0);
    expect(cy + halfH).toBeLessThanOrEqual(1);
  });
});

describe("landscape visual QA", () => {
  it("reads the landscape safe box instead of the portrait one", () => {
    const landscapeBox = { left: 200, top: 100, right: 1700, bottom: 190 };
    expect(outsideSafeBox(landscapeBox, LANDSCAPE_GEOMETRY)).toBe(false);
    expect(outsideSafeBox(landscapeBox)).toBe(true);
    // Never disabled: text pushed past the landscape margin still trips the check.
    expect(
      outsideSafeBox({ left: -20, top: 100, right: 700, bottom: 190 }, LANDSCAPE_GEOMETRY),
    ).toBe(true);
  });

  it("runs the scene checks per canvas and blocks misplaced text and cropped actors", () => {
    const clean = sceneSpecFindings({
      scenes: [base],
      characterKeys: ["alex"],
      canvas: "landscape",
    });
    expect(blockReasons(clean)).toEqual([]);
    const wide: SceneSpec = {
      ...base,
      overlays: [
        { text: "A VERY LONG HEADLINE THAT NEEDS THE FULL WIDTH OF A WIDE FRAME", position: "top" },
      ],
    };
    expect(
      blockReasons(
        sceneSpecFindings({ scenes: [wide], characterKeys: ["alex"], canvas: "landscape" }),
      ),
    ).toEqual([]);
    // Crop is measured against the 1920x1080 frame: a box half off the right edge is cropped.
    expect(
      cropFraction({ left: 1700, top: 100, right: 2140, bottom: 500 }, LANDSCAPE_GEOMETRY),
    ).toBeGreaterThan(0.4);
    expect(cropFraction({ left: 1700, top: 100, right: 2140, bottom: 500 })).toBeGreaterThan(0.9);
    expect(
      blockReasons(sceneSpecFindings({ scenes: [base], characterKeys: [], canvas: "landscape" })),
    ).toContain("catalog_ref_invalid");
  });

  it("checks frame metrics against the landscape safe box and hero columns", () => {
    const plan = planFor(base, "landscape");
    const text = captionBox(plan, "Why is milk at the back?");
    const metrics = (box: typeof text.box, centroidX: number): FrameMetrics => ({
      actorAreaPct: 9,
      actorCentroid: { x: centroidX, y: 0.6 },
      focalContrast: null,
      accentShare: 0.01,
      valueTiers: [0.15, 0.25, 0.6],
      dominantArea: 0.5,
      secondaryArea: 0.2,
      meanHex: "#808080",
      texts: [{ text: { ...text, box }, actorOverlap: 0, bgHex: "#808080" }],
    });
    const ids = (box: typeof text.box, x: number) =>
      frameFindings({ metrics: metrics(box, x), plan, sceneIndex: 0, hook: false }).map(
        (f) => f.id,
      );
    expect(ids(text.box, 0.5)).not.toContain("text_outside_safe_box");
    expect(ids({ ...text.box, left: -60, right: 500 }, 0.5)).toContain("text_outside_safe_box");
  });
});
