import { describe, expect, it } from "vitest";
import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import {
  type ActorAction,
  collectSceneSpecIssues,
  type SceneSpec,
} from "../explainer/scene-spec.js";
import { narrationMsPerWord } from "../explainer/script-guards.js";
import { normalizeActionTimings } from "./director-timing.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
/** Ten words, so the scene lasts ten narration words. */
const body = "Um dois três quatro cinco seis sete oito nove dez.";
const msPerWord = narrationMsPerWord("pt-BR");
const scene = (actions: readonly ActorAction[]): SceneSpec => ({
  index: 1,
  fromChar: 0,
  toChar: body.length,
  purpose: "hook",
  background: "kitchen",
  actors: [
    { characterKey: "alex", pose: "neutral", expression: "neutral", position: "center", actions },
  ],
  props: [{ type: "phone", position: "right" }],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
});
const run = (actions: readonly ActorAction[]) => {
  const [out] = normalizeActionTimings([scene(actions)], body, "pt-BR");
  if (!out) throw new Error("scene_missing");
  const issues = collectSceneSpecIssues({
    scenes: [{ ...out, purpose: "payoff" }],
    characters: [alex],
    claims: [],
    renderer: "stickman_motion",
    language: "pt-BR",
    sceneTexts: [body],
  }).filter((issue) => issue.code.startsWith("action"));
  return { actions: out.actors[0]?.actions ?? [], issues };
};
const target = { kind: "prop", index: 0 } as const;

describe("normalizeActionTimings", () => {
  it("leaves valid actions untouched", () => {
    const actions: ActorAction[] = [
      { type: "walk_to", atWord: 0, to: "right" },
      { type: "point_at", atWord: 4, target },
    ];
    expect(run(actions)).toEqual({ actions, issues: [] });
  });

  it("shortens an action that runs past the scene to the time left", () => {
    const { actions, issues } = run([
      { type: "emote", atWord: 8, emotion: "excited", durationMs: 3_000 },
    ]);
    expect(issues).toEqual([]);
    expect(actions[0]).toMatchObject({ type: "emote", atWord: 8 });
    expect((actions[0] as { durationMs: number }).durationMs).toBeLessThan(3_000);
  });

  it("clamps out-of-range anchors and durations into the validator's bounds", () => {
    const { actions, issues } = run([
      { type: "look_at", atWord: 40, target, durationMs: 100 },
      { type: "emote", atWord: 0, emotion: "excited", durationMs: 500 },
    ]);
    expect(issues).toEqual([]);
    expect(actions).toContainEqual({
      type: "emote",
      atWord: 0,
      emotion: "excited",
      durationMs: 900,
    });
    expect(actions).toContainEqual({ type: "look_at", atWord: 9, target, durationMs: 200 });
  });

  it("delays a point_at that would overlap a walk until the walk ends", () => {
    const { actions, issues } = run([
      { type: "walk_to", atWord: 0, to: "right", durationMs: 1_500 },
      { type: "point_at", atWord: 1, target },
    ]);
    expect(issues).toEqual([]);
    expect(actions[0]).toEqual({ type: "walk_to", atWord: 0, to: "right", durationMs: 1_500 });
    expect(actions[1]?.atWord).toBe(Math.ceil(1_500 / msPerWord));
  });

  it("removes the lower-priority action when nothing else resolves the overlap", () => {
    const { actions, issues } = run([
      { type: "look_at", atWord: 9, target, durationMs: 400 },
      { type: "look_at", atWord: 9, target, priority: "ambient" },
    ]);
    expect(issues).toEqual([]);
    expect(actions).toEqual([{ type: "look_at", atWord: 9, target, durationMs: 400 }]);
  });

  it("resolves every timing conflict between any two actions on any words", () => {
    const templates = (atWord: number): ActorAction[] => [
      { type: "walk_to", atWord, to: "left", durationMs: 2_500 },
      { type: "enter", atWord, from: "right" },
      { type: "exit", atWord, to: "left" },
      { type: "jump", atWord },
      { type: "pose", atWord, pose: "thinking", durationMs: 4_000 },
      { type: "point_at", atWord, target, durationMs: 3_000 },
      { type: "look_at", atWord, target, priority: "secondary" },
      { type: "emote", atWord, emotion: "worried", durationMs: 4_000 },
      { type: "react", atWord, mark: "exclaim" },
      { type: "expression", atWord: atWord + 20, expression: "happy" },
    ];
    for (const first of [0, 3, 9])
      for (const second of [0, 2, 9])
        for (const a of templates(first))
          for (const b of templates(second)) expect(run([a, b]).issues).toEqual([]);
  });
});
