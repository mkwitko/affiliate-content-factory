import { describe, expect, it } from "vitest";
import {
  ACTING_PRESETS,
  actingFactor,
  actingGrammar,
  NEUTRAL_ACTING,
  readActingProfile,
} from "./acting.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import { composeMotionFrame } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import { GRAMMAR } from "./motion/tuning.js";
import type { SceneSpec } from "./scene-spec.js";

const character = (
  key: string,
  role: "main" | "secondary",
  acting?: object,
): ExplainerCharacter => ({
  key,
  name: key,
  role,
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  ...(acting
    ? {
        bible: {
          version: 1,
          role: "lead",
          body: { archetype: "average", head: "circle", scale: 1 },
          acting: readActingProfile(acting) ?? NEUTRAL_ACTING,
        },
      }
    : {}),
});
const timing: MotionSceneTiming = {
  startMs: 0,
  endMs: 5_000,
  voiceStartMs: 200,
  voiceEndMs: 4_600,
  text: "a b c d e f g h",
  words: Array.from({ length: 8 }, (_, i) => ({
    text: "abcdefgh"[i] ?? "a",
    startMs: 200 + i * 550,
    endMs: 700 + i * 550,
  })),
};
const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 15,
  purpose: "explanation",
  background: "plain",
  actors: [
    {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "left",
      actions: [
        { type: "point_at", atWord: 2, target: { kind: "prop", index: 0 }, durationMs: 1_200 },
      ],
    },
    {
      characterKey: "bia",
      pose: "neutral",
      expression: "neutral",
      position: "right",
      actions: [{ type: "react", atWord: 3, mark: "exclaim" }],
    },
  ],
  props: [{ type: "lightbulb", position: "top" }],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "none",
};
const plan = (acting?: object, motionGrammar = true) =>
  planMotion({
    scenes: [scene],
    timings: [timing],
    characters: [character("alex", "main", acting), character("bia", "secondary", acting)],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: 5_000,
    motionGrammar,
  });
const react = (p: ReturnType<typeof plan>) => p.scenes[0]?.actors[1]?.actions[0]?.startMs ?? -1;
const times = [1_300, 1_450, 1_700, 2_200];

describe("acting profile", () => {
  it("passes through 1 at the neutral 0.5", () => {
    expect(actingFactor(0.5, 0.7, 1.4)).toBe(1);
    expect(actingFactor(0, 0.7, 1.4)).toBe(0.7);
    expect(actingFactor(1, 0.7, 1.4)).toBe(1.4);
    expect(actingGrammar(GRAMMAR, NEUTRAL_ACTING)).toEqual(GRAMMAR);
  });

  it("neutral acting draws the plain grammar's frames and timings", () => {
    for (const t of times)
      expect(composeMotionFrame(plan({}), t)).toBe(composeMotionFrame(plan(), t));
    expect(react(plan({}))).toBe(react(plan()));
  });

  it("two presets give the same action different timing and frames", () => {
    const energetic = plan(ACTING_PRESETS.energetic);
    const calm = plan(ACTING_PRESETS.calm);
    expect(react(energetic)).toBeLessThan(react(plan()));
    expect(react(calm)).toBeGreaterThan(react(plan()));
    expect(
      times.some((t) => composeMotionFrame(energetic, t) !== composeMotionFrame(calm, t)),
    ).toBe(true);
  });

  it("is ignored with the grammar off", () => {
    for (const t of times)
      expect(composeMotionFrame(plan(ACTING_PRESETS.showman, false), t)).toBe(
        composeMotionFrame(plan(undefined, false), t),
      );
  });

  it("clamps stored values", () => {
    expect(readActingProfile({ energy: 3, reactionDelayMs: 10 })).toMatchObject({
      energy: 1,
      reactionDelayMs: 80,
    });
    expect(Object.keys(ACTING_PRESETS)).toHaveLength(6);
  });
});
