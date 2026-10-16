import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "../explainer-context.js";
import type { ActorAction, SceneSpec } from "../scene-spec.js";
import { type MotionPlan, type MotionSceneTiming, planMotion } from "./plan.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
};
const scene = (index: number, over: Partial<SceneSpec> = {}): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: 1,
  purpose: "explanation",
  background: "store",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
/** Words spoken at 400 ms each from the clip start. */
const timing = (startMs: number, text: string, gapMs = 300): MotionSceneTiming => {
  const tokens = text.split(" ");
  const voiceStartMs = startMs + gapMs;
  const words = tokens.map((word, i) => ({
    text: word,
    startMs: voiceStartMs + i * 400,
    endMs: voiceStartMs + i * 400 + 350,
  }));
  const voiceEndMs = voiceStartMs + tokens.length * 400;
  return { startMs, endMs: voiceEndMs + 500, voiceStartMs, voiceEndMs, words, text };
};
const plan = (scenes: readonly SceneSpec[], timings: readonly MotionSceneTiming[]) =>
  planMotion({
    scenes,
    timings,
    characters: [alex],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: timings.at(-1)?.endMs ?? 0,
  });

describe("planMotion", () => {
  it("anchors actions to the narration word they name", () => {
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
        actions: [{ type: "jump" as const, atWord: 2 }],
      },
    ];
    const result = plan([scene(1, { actors })], [timing(0, "why is milk at the back")]);
    const jump = result.scenes[0]?.actors[0]?.actions[0];
    expect(jump).toMatchObject({ startMs: 300 + 2 * 400, endMs: 300 + 2 * 400 + 600 });
    expect(result.notes).toEqual([]);
    expect(result.sfx).toContainEqual({ id: "thud", atMs: 1_700 });
  });

  it("falls back to proportional timing when the spoken words do not match the text", () => {
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
        actions: [{ type: "expression" as const, atWord: 3, expression: "happy" as const }],
      },
    ];
    const spoken = { ...timing(0, "why is milk at the back"), text: "Why is the milk at back?" };
    const result = plan([scene(1, { actors })], [spoken]);
    expect(result.notes).toEqual(["action_timing_estimated:1"]);
    // 6 text words across a 2400 ms clip: word 3 starts 1200 ms in.
    expect(result.scenes[0]?.actors[0]?.actions[0]?.startMs).toBe(300 + 1_200);
  });

  it("keeps contractions as one word when matching the spoken words", () => {
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
        actions: [{ type: "jump" as const, atWord: 3 }],
      },
    ];
    const result = plan([scene(1, { actors })], [timing(0, "the store isn't lost")]);
    expect(result.notes).toEqual([]);
    expect(result.scenes[0]?.actors[0]?.actions[0]?.startMs).toBe(300 + 3 * 400);
  });

  it("compresses an action to fit the scene, and drops one that cannot start in time", () => {
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
        actions: [
          { type: "walk_to" as const, atWord: 4, to: "left" as const, durationMs: 3_000 },
          { type: "react" as const, atWord: 5, mark: "sparkle" as const },
        ],
      },
    ];
    const t = timing(0, "one two three four five six");
    const result = plan([scene(1, { actors })], [{ ...t, endMs: 2_750 }]);
    const [walk, react] = result.scenes[0]?.actors[0]?.actions ?? [];
    expect(walk).toMatchObject({ startMs: 1_900, endMs: 2_750 });
    expect(react).toMatchObject({ startMs: 2_300, endMs: 2_750 });
    const late = plan([scene(1, { actors })], [{ ...t, endMs: 2_000 }]);
    expect(late.notes).toContain("action_dropped:1");
  });

  it("groups captions by the niche word count and never across a sentence end", () => {
    const text = "Milk sits at the back. Why? Because you walk past everything.";
    const t = timing(0, text);
    const groups = plan([scene(1)], [t]).scenes[0]?.captions.map((group) =>
      group.words.map((word) => word.text).join(" "),
    );
    expect(groups).toEqual([
      "Milk sits at",
      "the back.",
      "Why?",
      "Because you walk",
      "past everything.",
    ]);
  });

  it("cues sound effects for transitions, props, diagram steps and the payoff", () => {
    const result = plan(
      [
        scene(1, { purpose: "hook", props: [{ type: "milk_carton", position: "right" }] }),
        scene(2, {
          transition: "wipe",
          diagram: {
            kind: "flow",
            nodes: [
              { id: "a", label: "Door" },
              { id: "b", label: "Aisles" },
            ],
            edges: [{ from: "a", to: "b" }],
          },
        }),
        scene(3, { purpose: "payoff" }),
      ],
      [timing(0, "one two"), timing(1_600, "three four"), timing(3_200, "five six")],
    );
    const ids = result.sfx.map((cue) => cue.id);
    expect(ids).toContain("pop");
    expect(result.sfx).toContainEqual({ id: "whoosh", atMs: 1_600 });
    expect(ids.filter((id) => id === "tick")).toHaveLength(2);
    expect(result.sfx).toContainEqual({ id: "ding", atMs: 3_500 });
  });

  it("plans the silence between narration clips so the quality gate does not flag it", () => {
    const result = plan([scene(1), scene(2)], [timing(0, "one two"), timing(1_600, "three four")]);
    expect(result.plannedSilence).toEqual([
      { startMs: 0, endMs: 300 },
      { startMs: 1_100, endMs: 1_900 },
      { startMs: 2_700, endMs: 3_200 },
    ]);
  });

  it("resolves where point_at aims and drops one whose target is missing", () => {
    const actors = (index: number) => [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "left" as const,
        actions: [
          { type: "point_at" as const, atWord: 1, target: { kind: "prop" as const, index } },
        ],
      },
    ];
    const props = [{ type: "coin" as const, position: "right" as const }];
    const t = timing(0, "look at this price");
    const aimed = plan([scene(1, { actors: actors(0), props })], [t]);
    expect(aimed.scenes[0]?.actors[0]?.actions[0]).toMatchObject({
      startMs: 700,
      endMs: 1_900,
      target: { x: 780, y: 780 },
    });
    const missing = plan([scene(1, { actors: actors(1), props })], [t]);
    expect(missing.scenes[0]?.actors[0]?.actions).toEqual([]);
    expect(missing.notes).toContain("action_dropped:1");
  });

  it("plans idle blinks per scene and character, identical on every render", () => {
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const scenes = [scene(1), scene(2, { background: "bank" })];
    // Each scene: voice 300 to 8300 ms after its start, 8800 ms long.
    const timings = [timing(0, text), timing(9_000, text)];
    const first = plan(scenes, timings);
    const again = plan(scenes, timings);
    const idle = (p: MotionPlan, i: number) => p.scenes[i]?.actors[0]?.idle;
    expect(idle(again, 0)).toEqual(idle(first, 0));
    const blinks = idle(first, 0)?.blinksAtMs ?? [];
    expect(blinks.length).toBeGreaterThanOrEqual(2);
    expect(blinks.every((at) => at >= 400 && at < 8_800)).toBe(true);
    expect(
      blinks.slice(1).every((at, i) => {
        const gap = at - (blinks[i] ?? 0);
        return gap === 220 || gap >= 1_980;
      }),
    ).toBe(true);
    const shifted = (idle(first, 1)?.blinksAtMs ?? []).map((at) => at - 9_000);
    expect(shifted).not.toEqual(blinks);
    const period = idle(first, 0)?.breathPeriodMs ?? 0;
    expect(period).toBeGreaterThanOrEqual(2_600);
    expect(period).toBeLessThanOrEqual(3_400);
  });

  it("aims look_at at another actor's head on the stage", () => {
    const bia: ExplainerCharacter = { ...alex, key: "bia", name: "Bia", role: "secondary" };
    const result = planMotion({
      scenes: [
        scene(1, {
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "left",
              actions: [
                { type: "look_at", atWord: 1, target: { kind: "actor", characterKey: "bia" } },
              ],
            },
            { characterKey: "bia", pose: "neutral", expression: "neutral", position: "right" },
          ],
        }),
      ],
      timings: [timing(0, "look at this price")],
      characters: [alex, bia],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 2_400,
    });
    // Medium shot, no diagram: scale 1, head centre 438 px above the 1180 baseline.
    expect(result.scenes[0]?.actors[0]?.actions[0]?.target).toEqual({ x: 780, y: 742 });
  });

  const actorWith = (actions: readonly ActorAction[]) => [
    {
      characterKey: "alex",
      pose: "neutral" as const,
      expression: "neutral" as const,
      position: "center" as const,
      actions,
    },
  ];

  it("expands an emote into a start, a middle and an end that return to the previous pose", () => {
    const t = timing(0, "look at this price right now please");
    const searching = plan(
      [scene(1, { actors: actorWith([{ type: "emote", atWord: 1, emotion: "searching" }]) })],
      [t],
    );
    const steps = searching.scenes[0]?.actors[0]?.actions ?? [];
    // Word 1 starts at 700 ms; the default 1800 ms runs to 2500 ms.
    expect(steps.map(({ action, startMs, endMs }) => [action.type, startMs, endMs])).toEqual([
      ["emote", 700, 2_500],
      ["expression", 700, 850],
      ["pose", 700, 1_060],
      ["look_at", 1_060, 1_564],
      ["look_at", 1_600, 2_104],
      ["pose", 2_050, 2_500],
      ["expression", 2_320, 2_470],
    ]);
    // Medium shot: the head centre sits 438 px above the 1180 baseline; glances aim 400 px aside.
    expect(
      steps.filter((step) => step.action.type === "look_at").map((step) => step.target),
    ).toEqual([
      { x: 140, y: 742 },
      { x: 940, y: 742 },
    ]);
    // After an earlier pose, the emote returns to that pose, not the declared one.
    const afterPose = plan(
      [
        scene(1, {
          actors: actorWith([
            { type: "pose", atWord: 0, pose: "pointing" },
            { type: "emote", atWord: 2, emotion: "frustrated" },
          ]),
        }),
      ],
      [t],
    );
    const tail = afterPose.scenes[0]?.actors[0]?.actions.slice(-2) ?? [];
    expect(tail).toMatchObject([
      { action: { type: "pose", pose: "pointing" }, startMs: 2_450, endMs: 2_900 },
      { action: { type: "expression", expression: "neutral" } },
    ]);
  });

  it("drops an emote squeezed below 900 ms or naming an unknown emotion", () => {
    // "look at this" ends at 2000 ms; the walk holds the stage until 1800 ms.
    const squeezed = plan(
      [
        scene(1, {
          actors: actorWith([
            { type: "walk_to", atWord: 0, to: "left", durationMs: 1_500 },
            { type: "emote", atWord: 1, emotion: "excited" },
          ]),
        }),
      ],
      [timing(0, "look at this")],
    );
    expect(squeezed.scenes[0]?.actors[0]?.actions.map((step) => step.action.type)).toEqual([
      "walk_to",
    ]);
    expect(squeezed.notes).toContain("action_dropped:1");
    const unknown = plan(
      [
        scene(1, {
          actors: actorWith([{ type: "emote", atWord: 1, emotion: "bored" as never }]),
        }),
      ],
      [timing(0, "look at this price right now please")],
    );
    expect(unknown.scenes[0]?.actors[0]?.actions).toEqual([]);
    expect(unknown.notes).toContain("action_dropped:1");
  });
});
