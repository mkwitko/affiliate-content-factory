import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
  readExplainerContext,
} from "./explainer-context.js";
import { CAPTION_RECT, headBand, LAYOUT_IDS, LAYOUTS, rectsOverlap } from "./layouts.js";
import { locationWarnings, readLocations, resolveLocationScene } from "./locations.js";
import { composeMotionFrame } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import { type SceneSpec, validateSceneSpecs } from "./scene-spec.js";
import { SHOT_SCALE } from "./shots.js";

const LOCATIONS = [
  {
    id: "office_a",
    name: "Escritório",
    plate: { assetId: "plate-office", overscan: 2.2 },
    proceduralFallback: "office",
    zones: [
      {
        id: "desk_medium",
        crop: { cx: 0.4, cy: 0.5, zoom: 1.1 },
        allowedShots: ["medium", "two_shot"],
        maxActors: 2,
        layouts: ["SOLO_LEFT", "TWO_SHOT"],
      },
      { id: "door_wide", allowedShots: ["wide", "establishing"], maxActors: 3 },
    ],
    anchors: [
      { id: "desk_left", x: 0.28, facing: "right", scale: 1.05 },
      { id: "desk_right", x: 0.72, facing: "left", pose: "sit" },
    ],
  },
  {
    id: "market_a",
    name: "Mercado",
    plate: { assetId: "plate-market" },
    proceduralFallback: "store",
    zones: [{ id: "aisle", allowedShots: ["wide", "medium"], maxActors: 3 }],
    anchors: [{ id: "cart", x: 0.5, facing: "right" }],
  },
];
const locations = readLocations(LOCATIONS);
const alexActor: SceneSpec["actors"][number] = {
  characterKey: "alex",
  pose: "neutral",
  expression: "neutral",
  position: "center",
};
const base: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 20,
  purpose: "hook",
  background: "plain",
  actors: [alexActor],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
};
const at = (over: Partial<SceneSpec>): SceneSpec => ({ ...base, ...over });

describe("readLocations", () => {
  it("reads both locations and drops invalid ones", () => {
    expect(locations.map((l) => l.id)).toEqual(["office_a", "market_a"]);
    expect(
      readLocations([
        { id: "Bad Id", name: "x", proceduralFallback: "office" },
        { id: "ok", name: "x", proceduralFallback: "moon" },
      ]),
    ).toEqual([]);
    expect(locations[0]?.zones[1]?.layouts.length).toBe(LAYOUT_IDS.length);
  });

  it("flags anchors facing out of frame", () => {
    const [bad] = readLocations([
      { ...LOCATIONS[1], anchors: [{ id: "edge", x: 0.1, facing: "left" }] },
    ]);
    expect(bad ? locationWarnings(bad) : []).toEqual(["anchor_faces_out:market_a:edge"]);
    expect(locations.flatMap(locationWarnings)).toEqual([]);
  });
});

describe("resolveLocationScene", () => {
  it("leaves scenes without ids untouched", () => {
    expect(resolveLocationScene(base, locations)).toEqual({ ok: true, scene: base });
  });

  it("derives background, plate and actor placement from the location", () => {
    const resolved = resolveLocationScene(
      at({
        locationId: "office_a",
        zoneId: "desk_medium",
        layoutId: "TWO_SHOT",
        camera: { shot: "two_shot", movement: "none" },
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "happy",
            position: "center",
            anchorId: "desk_left",
          },
          {
            characterKey: "bia",
            pose: "neutral",
            expression: "neutral",
            position: "center",
            anchorId: "desk_right",
          },
        ],
      }),
      locations,
    );
    expect(resolved.ok && resolved.scene).toMatchObject({
      background: "office",
      backgroundAssetId: "plate-office",
      actors: [
        { position: "left", facing: "right", scale: 1.05 },
        { position: "right", facing: "left", pose: "sitting" },
      ],
    });
  });

  it.each([
    ["location_unknown", { locationId: "moon" }],
    ["location_unknown", { zoneId: "desk_medium" }],
    ["zone_unknown", { locationId: "office_a", zoneId: "roof" }],
    [
      "zone_shot_not_allowed",
      { locationId: "office_a", zoneId: "desk_medium", camera: { shot: "wide", movement: "none" } },
    ],
    [
      "zone_layout_not_allowed",
      { locationId: "office_a", zoneId: "desk_medium", layoutId: "SOLO_CENTER" },
    ],
    ["anchor_unknown", { locationId: "office_a", actors: [{ ...alexActor, anchorId: "sofa" }] }],
    ["layout_unknown", { layoutId: "NOPE" }],
  ] as const)("refuses %s", (reason, over) => {
    expect(resolveLocationScene(at(over as Partial<SceneSpec>), locations)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe("layouts and shots", () => {
  it("never puts text over a head or on the caption band, and stays in frame", () => {
    for (const layout of Object.values(LAYOUTS)) {
      const rects = [
        ...layout.actorRects,
        layout.textRect,
        layout.propRect,
        layout.diagramRect,
      ].flatMap((r) => (r ? [r] : []));
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1);
        expect(r.y + r.h).toBeLessThanOrEqual(1);
      }
      if (layout.textRect) {
        expect(rectsOverlap(layout.textRect, CAPTION_RECT)).toBe(false);
        for (const actor of layout.actorRects)
          expect(rectsOverlap(layout.textRect, headBand(actor))).toBe(false);
      }
    }
  });

  it("maps the new shot kinds and keeps the old scales", () => {
    expect([SHOT_SCALE.wide, SHOT_SCALE.medium, SHOT_SCALE.close]).toEqual([0.8, 1, 1.3]);
    expect(SHOT_SCALE.establishing).toBe(0.7);
    expect(SHOT_SCALE.insert).toBe(1.2);
  });
});

describe("validator rules", () => {
  const alex: ExplainerCharacter = {
    key: "alex",
    name: "Alex",
    role: "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  };
  const payoff = at({
    index: 2,
    purpose: "payoff",
    background: "store",
    camera: { shot: "wide", movement: "none" },
  });
  const check = (scene: SceneSpec) =>
    validateSceneSpecs({
      scenes: [scene, payoff],
      characters: [alex],
      claims: [],
      renderer: "stickman_motion",
      language: "en",
      sceneTexts: ["a b c d", "e f g h"],
    });

  it.each([
    ["shot_capacity", { camera: { shot: "two_shot", movement: "none" } }],
    ["shot_needs_prop", { actors: [], camera: { shot: "insert", movement: "none" } }],
    ["layout_actor_position", { layoutId: "SOLO_LEFT" }],
    ["layout_needs_diagram", { layoutId: "ACTOR_DIAGRAM_SPLIT" }],
  ] as const)("%s", (reason, over) => {
    expect(check(at(over as Partial<SceneSpec>))).toMatchObject({
      ok: false,
      rejection: { reason },
    });
  });

  it("accepts a scene that fits its layout", () => {
    expect(check(at({ layoutId: "SOLO_CENTER" }))).toEqual({ ok: true });
  });
});

describe("acceptance: a niche with two plated locations", () => {
  const context = readExplainerContext({
    kind: "media",
    context: { explainer: { locations: LOCATIONS } },
  });
  const timing: MotionSceneTiming = {
    startMs: 0,
    endMs: 3_000,
    voiceStartMs: 200,
    voiceEndMs: 2_600,
    text: "one two three four",
    words: ["one", "two", "three", "four"].map((text, i) => ({
      text,
      startMs: 200 + i * 600,
      endMs: 700 + i * 600,
    })),
  };
  const cast: ExplainerCharacter[] = [
    {
      key: "alex",
      name: "Alex",
      role: "main",
      rigId: "stick-v1",
      rigVersion: 1,
      palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
    },
  ];
  const frames = (scene: SceneSpec) => {
    const plan = planMotion({
      scenes: [scene],
      timings: [timing],
      characters: cast,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 3_000,
      backgroundArt: new Map([
        ["plate-office", { href: "data:image/png;base64,AA==" }],
        ["plate-market", { href: "data:image/png;base64,AB==" }],
      ]),
    });
    return [300, 1_500, 2_700].map((t) => composeMotionFrame(plan, t));
  };

  it("renders an id-based storyboard exactly like its explicit equivalent", () => {
    expect(context?.locations?.length).toBe(2);
    const byIds = at({
      locationId: "market_a",
      zoneId: "aisle",
      actors: [{ ...alexActor, anchorId: "cart" }],
    });
    const resolved = resolveLocationScene(byIds, context?.locations ?? []);
    if (!resolved.ok) throw new Error(resolved.reason);
    const explicit = at({
      background: "store",
      backgroundAssetId: "plate-market",
      actors: [{ ...alexActor, position: "center", facing: "right", scale: 1 }],
    });
    expect(frames(resolved.scene)).toEqual(frames(explicit));
  });
});

describe("lighting grades on read", () => {
  it("keeps only hex tints and clamps alphas", () => {
    const [location] = readLocations([
      {
        ...LOCATIONS[1],
        lighting: {
          night: { tint: "#1d2a5a", tintAlpha: 3, shadowAlpha: 0.3, vignette: 0.2 },
          dusk: { tint: '"/><script>', tintAlpha: 0.2, shadowAlpha: 0, vignette: 0 },
        },
      },
    ]);
    expect(location?.lighting).toEqual({
      night: { tint: "#1d2a5a", tintAlpha: 0, shadowAlpha: 0.3, vignette: 0.2 },
    });
  });
});
