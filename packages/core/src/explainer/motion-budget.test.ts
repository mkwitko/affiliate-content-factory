import { describe, expect, it } from "vitest";
import {
  MOTION_TEST_ID,
  STYLE_FRAME_LANGUAGE,
  STYLE_FRAME_SHOTS,
  styleFrameStoryboard,
} from "./fixtures/style-frames/fixtures.js";
import { motionBudgetHint, motionBudgetWarnings } from "./motion-budget.js";
import type { ActorAction, SceneSpec } from "./scene-spec.js";
import { sceneSpecWarnings } from "./scene-spec.js";

// 12 words at 165 wpm (en): ~4.4 s; each word ~364 ms.
const text = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
const scene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  index: 1,
  fromChar: 0,
  toChar: text.length,
  purpose: "explanation",
  background: "store",
  actors: [],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const actor = (actions: readonly ActorAction[]) => [
  {
    characterKey: "alex",
    pose: "neutral",
    expression: "neutral",
    position: "center",
    actions,
  } as const,
];
const warn = (over: Partial<SceneSpec>) =>
  motionBudgetWarnings({ scenes: [scene(over)], language: "en-US", sceneTexts: [text] });

describe("motionBudgetWarnings", () => {
  it.each([
    [
      "motion_budget when three big moves land in one window",
      {
        actors: actor([
          { type: "jump", atWord: 4 },
          { type: "emote", atWord: 5, emotion: "excited" },
        ]),
        props: [{ type: "phone", position: "right" }],
        camera: { shot: "medium", movement: "push_in" },
      },
      ["motion_budget:1"],
    ],
    [
      "no motion_budget once the lesser move is ambient",
      {
        actors: actor([
          { type: "jump", atWord: 4 },
          { type: "emote", atWord: 5, emotion: "excited", priority: "ambient" },
          { type: "point_at", atWord: 9, target: { kind: "prop", index: 0 } },
        ]),
        props: [{ type: "phone", position: "right" }],
        camera: { shot: "medium", movement: "push_in" },
      },
      [],
    ],
    [
      "camera_information when the camera pans under an overlay",
      {
        actors: actor([{ type: "look_at", atWord: 5, target: { kind: "overlay", index: 0 } }]),
        overlays: [{ text: "R$ 47", position: "top" }],
        camera: { shot: "medium", movement: "pan_left" },
      },
      ["camera_information:1"],
    ],
    [
      "no camera_information under a handheld camera",
      {
        actors: actor([{ type: "look_at", atWord: 5, target: { kind: "overlay", index: 0 } }]),
        overlays: [{ text: "R$ 47", position: "top" }],
        camera: { shot: "medium", movement: "handheld" },
      },
      [],
    ],
    [
      "cadence_gap when nothing primary happens after the cut",
      {
        actors: actor(
          [{ type: "look_at", atWord: 1, priority: "secondary" }].map(
            (a) => ({ ...a, target: { kind: "diagram" } }) as ActorAction,
          ),
        ),
      },
      ["cadence_gap:1"],
    ],
    [
      "no cadence_gap for an intentional still",
      { actors: actor([]), holdMode: "intentional_still" },
      [],
    ],
    [
      "no cadence_gap when a primary beat lands mid scene",
      { actors: actor([{ type: "pose", atWord: 6, pose: "pointing" }]) },
      [],
    ],
  ] as const)("%s", (_name, over, expected) => {
    expect(warn(over as Partial<SceneSpec>)).toEqual(expected);
  });

  it("cut_hold for a non-entrance primary action on the word after the cut", () => {
    expect(warn({ actors: actor([{ type: "pose", atWord: 1, pose: "pointing" }]) })).toContain(
      "cut_hold:1",
    );
    expect(
      warn({
        actors: actor([{ type: "pose", atWord: 1, pose: "pointing", priority: "secondary" }]),
      }),
    ).not.toContain("cut_hold:1");
    expect(warn({ actors: actor([{ type: "enter", atWord: 0, from: "left" }]) })).not.toContain(
      "cut_hold:1",
    );
    expect(warn({ actors: actor([{ type: "pose", atWord: 2, pose: "pointing" }]) })).not.toContain(
      "cut_hold:1",
    );
  });

  it("gives every warning a fix hint", () => {
    for (const id of ["motion_budget:3", "camera_information:1", "cut_hold:2", "cadence_gap:9"])
      expect(motionBudgetHint(id)).toMatch(/\w+/);
    expect(motionBudgetHint("static_stretch:1")).toBeUndefined();
  });
});

describe("existing fixtures", () => {
  it("only warn (never reject) and the motion test stays inside the budget", () => {
    const { scenes, texts } = styleFrameStoryboard();
    const warnings = sceneSpecWarnings({
      scenes,
      language: STYLE_FRAME_LANGUAGE,
      sceneTexts: texts,
    });
    const motionIndex = STYLE_FRAME_SHOTS.findIndex((shot) => shot.id === MOTION_TEST_ID) + 1;
    expect(warnings.filter((w) => w.endsWith(`:${motionIndex}`))).toEqual([]);
    expect(
      warnings.every((w) =>
        /^(static_stretch|motion_budget|camera_information|cut_hold|cadence_gap):\d+$/.test(w),
      ),
    ).toBe(true);
  });
});
