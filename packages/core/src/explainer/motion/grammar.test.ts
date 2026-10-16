import { createSceneSpecSchema } from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "../explainer-context.js";
import { STICK_V1_CATALOG } from "../scene-director.js";
import { SCENE_PURPOSES, type SceneSpec } from "../scene-spec.js";
import { anticipate, settle, snapToClass } from "./easing.js";
import { composeMotionFrame } from "./frame.js";
import { type MotionSceneTiming, planMotion } from "./plan.js";
import { GRAMMAR } from "./tuning.js";

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
  endMs: 6_000,
  voiceStartMs: 200,
  voiceEndMs: 5_600,
  text: "one two three four five six seven eight nine ten",
  words: Array.from({ length: 10 }, (_, i) => ({
    text: `w${i}`,
    startMs: 200 + i * 540,
    endMs: 700 + i * 540,
  })),
};
const scene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  index: 1,
  fromChar: 0,
  toChar: timing.text.length,
  purpose: "hook",
  background: "kitchen",
  actors: [
    {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "center",
      actions: [
        { type: "enter", atWord: 0, from: "left", durationMs: 900 },
        { type: "point_at", atWord: 5, target: { kind: "prop", index: 0 }, durationMs: 1_200 },
      ],
    },
  ],
  props: [{ type: "lightbulb", position: "right" }],
  overlays: [],
  camera: { shot: "wide", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const plan = (motionGrammar: boolean | undefined, over: Partial<SceneSpec> = {}) =>
  planMotion({
    scenes: [scene(over)],
    timings: [timing],
    characters: [alex],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: 6_000,
    ...(motionGrammar === undefined ? {} : { motionGrammar }),
  });

describe("grammar curves", () => {
  it("winds up below 0, overshoots about the configured share and settles at 1", () => {
    const dip = Math.min(
      ...Array.from({ length: 50 }, (_, i) => anticipate(i / 250, 0.2, 0.14, 0.12)),
    );
    expect(dip).toBeCloseTo(-0.14, 2);
    const peak = Math.max(...Array.from({ length: 200 }, (_, i) => settle(i / 200, 0.12)));
    expect(peak).toBeCloseTo(1.12, 3);
    expect(settle(0.999, 0.12)).toBeCloseTo(1, 2);
    expect(anticipate(1, 0.2, 0.14, 0.12)).toBe(1);
  });

  it("snaps stage lengths to duration classes at 30 fps", () => {
    expect(snapToClass(130, GRAMMAR.durationClassesFrames)).toBeCloseTo(133.33, 1);
    expect(snapToClass(5_000, GRAMMAR.durationClassesFrames)).toBeCloseTo(800, 1);
  });
});

describe("motion grammar in the composer", () => {
  it("draws identical frames when the grammar is off or unset", () => {
    for (const t of [300, 1_200, 3_000, 4_000])
      expect(composeMotionFrame(plan(false), t)).toBe(composeMotionFrame(plan(undefined), t));
  });

  it("changes the point and the walk when the grammar is on", () => {
    const pointAt = plan(true).scenes[0]?.actors[0]?.actions[1]?.startMs ?? 0;
    for (const t of [300, pointAt + 60, pointAt + 250])
      expect(composeMotionFrame(plan(true), t)).not.toBe(composeMotionFrame(plan(false), t));
    expect(composeMotionFrame(plan(true), pointAt + 250)).toMatchSnapshot();
  });

  it("keeps an idle actor moving unless the scene is an intentional still", () => {
    // A listener (not the narrator, so no mouth), no captions; the camera's slow drift is
    // stripped, so only the actor is compared.
    const standing = (holdMode?: "intentional_still") =>
      planMotion({
        scenes: [
          scene({
            actors: [
              { characterKey: "bia", pose: "neutral", expression: "neutral", position: "center" },
            ],
            props: [],
            captionMode: "none",
            ...(holdMode ? { holdMode } : {}),
          }),
        ],
        timings: [timing],
        characters: [alex, { ...alex, key: "bia", name: "Bia", role: "secondary" }],
        palette: DEFAULT_SCENE_PALETTE,
        captionWords: 3,
        durationMs: 6_000,
        motionGrammar: true,
      });
    const actorOnly = (svg: string) =>
      svg.replace(/transform="translate\([^)]*\) scale\([^)]*\) translate\([^)]*\)"/g, "");
    const blinks = standing().scenes[0]?.actors[0]?.idle.blinksAtMs ?? [];
    const open = [1_000, 2_500, 4_000].filter((t) => blinks.every((at) => t < at || t > at + 200));
    const [a, b] = open;
    if (a === undefined || b === undefined) throw new Error("no blink-free times");
    expect(actorOnly(composeMotionFrame(standing(), a))).not.toBe(
      actorOnly(composeMotionFrame(standing(), b)),
    );
    expect(actorOnly(composeMotionFrame(standing("intentional_still"), a))).toBe(
      actorOnly(composeMotionFrame(standing("intentional_still"), b)),
    );
  });
});

describe("dead frames", () => {
  const empty = { actors: [], props: [], camera: { shot: "wide", movement: "none" } } as const;
  it("notes a motionless scene only with the grammar on and never for an intentional still", () => {
    expect(plan(true, empty).notes).toContain("dead_frames:1");
    expect(plan(false, empty).notes).not.toContain("dead_frames:1");
    expect(plan(true, { ...empty, holdMode: "intentional_still" }).notes).not.toContain(
      "dead_frames:1",
    );
    expect(plan(true).notes).not.toContain("dead_frames:1");
  });
});

describe("holdMode at the boundary", () => {
  it("is accepted by the shared SceneSpec schema and nothing else is", () => {
    const schema = createSceneSpecSchema({ purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG });
    const { index: _i, fromChar: _f, toChar: _t, ...body } = scene();
    const input = { ...body, index: 1, fromChar: 0, toChar: 10 };
    expect(schema.safeParse({ ...input, holdMode: "intentional_still" }).success).toBe(true);
    expect(schema.safeParse({ ...input, holdMode: "frozen" }).success).toBe(false);
  });
});
