import { describe, expect, it } from "vitest";
import {
  checkDialogue,
  composeDialogueTimeline,
  dialogueWarnings,
  type DialogueLine,
  lineWordRanges,
} from "./dialogue.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import { isKnownToken } from "./motion-tokens.js";
import { composeMotionFrame } from "./motion/frame.js";
import { planMotion } from "./motion/plan.js";
import { type SceneSpec, validateSceneSpecs } from "./scene-spec.js";
import { voiceSeparationWarnings } from "./voice.js";

// Script: "Quanto custa? Custa pouco. Sério?" — three lines, two speakers.
const text = "Quanto custa? Custa pouco. Sério?";
const lines: readonly DialogueLine[] = [
  { speakerKey: "bia", fromChar: 0, toChar: 13 },
  {
    speakerKey: "alex",
    fromChar: 14,
    toChar: 26,
    reactions: [{ reactorKey: "bia", atWord: 1, token: "SMALL_FLINCH" }],
  },
  { speakerKey: "bia", fromChar: 27, toChar: 33, interruptsPrev: true },
];
const palette = { line: "#161616", fill: "#ffffff", accent: "#ff5a36" };
const cast: ExplainerCharacter[] = [
  {
    key: "alex",
    name: "Alex",
    role: "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette,
    voiceId: "pm_alex",
  },
  {
    key: "bia",
    name: "Bia",
    role: "secondary",
    rigId: "stick-v1",
    rigVersion: 1,
    palette,
    voiceId: "pf_dora",
  },
];
const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: text.length,
  purpose: "hook",
  background: "plain",
  actors: [
    {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "left",
      facing: "right",
    },
    {
      characterKey: "bia",
      pose: "neutral",
      expression: "neutral",
      position: "right",
      facing: "left",
    },
  ],
  props: [],
  overlays: [],
  camera: { shot: "two_shot", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  dialogue: lines,
};
const known = (token: string) => isKnownToken({ token });
// validateSceneSpecs also refuses reaction tokens that need a target (reactions have none).

describe("checkDialogue", () => {
  it("accepts lines that cover the scene in order", () => {
    expect(checkDialogue({ lines, scene, sceneText: text, knownTokens: known })).toBeNull();
    expect(lineWordRanges(text, 0, lines)).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
      { from: 4, to: 5 },
    ]);
  });

  it.each([
    ["dialogue_coverage", [lines[0], lines[2]]],
    ["dialogue_coverage", [lines[0]]],
    ["dialogue_speaker_missing", [{ ...lines[0], speakerKey: "rafa" }, lines[1], lines[2]]],
    [
      "dialogue_narrator_interrupts",
      [lines[0], { ...lines[1], speakerKey: "narrator", reactions: [] }, lines[2]],
    ],
    [
      "dialogue_reaction_invalid",
      [
        lines[0],
        { ...lines[1], reactions: [{ reactorKey: "alex", atWord: 0, token: "DOUBLE_TAKE" }] },
        lines[2],
      ],
    ],
  ] as const)("%s", (reason, bad) => {
    expect(
      checkDialogue({
        lines: bad as readonly DialogueLine[],
        scene,
        sceneText: text,
        knownTokens: known,
      }),
    ).toBe(reason);
  });

  it("is refused outside stickman_motion and validated inside it", () => {
    const payoff: SceneSpec = {
      ...scene,
      index: 2,
      purpose: "payoff",
      dialogue: undefined,
      fromChar: 34,
      toChar: 40,
      camera: { shot: "medium", movement: "none" },
      actors: [scene.actors[0] as SceneSpec["actors"][number]],
    };
    const input = { characters: cast, claims: [], language: "pt-BR", sceneTexts: [text, "e daí"] };
    expect(
      validateSceneSpecs({ ...input, scenes: [scene, payoff], renderer: "stickman_motion" }),
    ).toEqual({ ok: true });
    expect(
      validateSceneSpecs({ ...input, scenes: [scene, payoff], renderer: "stickman_still" }),
    ).toMatchObject({ ok: false, rejection: { reason: "dialogue_requires_motion" } });
  });
});

describe("composeDialogueTimeline", () => {
  const clip = (words: readonly string[]) => ({
    durationMs: words.length * 400,
    words: words.map((text, i) => ({ text, startMs: i * 400, endMs: i * 400 + 350 })),
  });
  const timeline = composeDialogueTimeline(lines, [
    clip(["Quanto", "custa"]),
    clip(["Custa", "pouco"]),
    clip(["Sério"]),
  ]);

  it("gaps speakers by 180 ms and overlaps an interruption by 300 ms", () => {
    // Line 2 ends at 980 + 800 = 1780; the interruption starts 300 ms earlier.
    expect(timeline.startsMs).toEqual([0, 980, 1_480]);
    expect(timeline.durationMs).toBe(1_880);
  });

  it("ducks and cuts the interrupted line at the next word boundary, dropping its cut words", () => {
    expect(timeline.edits[1]).toEqual({ trimMs: 750, duckFromMs: 500 });
    expect(timeline.words.map((w) => w.text)).toEqual([
      "Quanto",
      "custa",
      "Custa",
      "pouco",
      "Sério",
    ]);
  });

  it("warns about too many interruptions and dramatic pauses", () => {
    const many = [
      {
        index: 1,
        dialogue: [
          lines[0],
          lines[2],
          lines[2],
          { ...lines[0], pauseBeforeMs: 900 },
          { ...lines[0], pauseBeforeMs: 900 },
        ] as DialogueLine[],
      },
    ];
    expect(dialogueWarnings(many, 20_000)).toEqual([
      "dialogue_interruptions:2",
      "dialogue_pauses:2",
    ]);
  });

  it("flags shared and same-class voices", () => {
    expect(
      voiceSeparationWarnings([{ index: 1, dialogue: lines }], (key) =>
        key === "alex" ? "pf_a" : "pf_b",
      ),
    ).toEqual(["voice_close:bia:alex"]);
    expect(voiceSeparationWarnings([{ index: 1, dialogue: lines }], () => "pf_dora")).toEqual([
      "voice_shared:bia:alex",
    ]);
    expect(
      voiceSeparationWarnings([{ index: 1, dialogue: lines }], (key) =>
        key === "alex" ? "pm_a" : "pf_b",
      ),
    ).toEqual([]);
  });
});

describe("dialogue in the plan and frames", () => {
  const timeline = composeDialogueTimeline(lines, [
    {
      durationMs: 800,
      words: [
        { text: "Quanto", startMs: 0, endMs: 350 },
        { text: "custa", startMs: 400, endMs: 750 },
      ],
    },
    {
      durationMs: 800,
      words: [
        { text: "Custa", startMs: 0, endMs: 350 },
        { text: "pouco", startMs: 400, endMs: 750 },
      ],
    },
    { durationMs: 400, words: [{ text: "Sério", startMs: 0, endMs: 350 }] },
  ]);
  const shift = (ms: number) => ms + 200;
  const plan = planMotion({
    scenes: [scene],
    timings: [
      {
        startMs: 0,
        endMs: 2_600,
        voiceStartMs: 200,
        voiceEndMs: 200 + timeline.durationMs,
        text,
        words: timeline.words.map((w) => ({
          ...w,
          startMs: shift(w.startMs),
          endMs: shift(w.endMs),
        })),
      },
    ],
    characters: cast,
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: 2_600,
  });
  const planned = plan.scenes[0];

  it("gives each speaker its own words and turns reactions into the listener's actions", () => {
    expect(planned?.speakers?.map((s) => [s.characterKey, s.words.map((w) => w.text)])).toEqual([
      ["bia", ["Quanto", "custa"]],
      ["alex", ["Custa", "pouco"]],
      ["bia", ["Sério"]],
    ]);
    const bia = planned?.actors.find((a) => a.actor.characterKey === "bia");
    expect(bia?.actions.map((a) => a.action.type)).toEqual(["expression", "pose"]);
  });

  it("moves only the speaker's mouth", () => {
    // While Bia says "Quanto" (200-550 ms) alex's mouth rests; while alex speaks, Bia's rests.
    const biaSpeaks = composeMotionFrame(plan, 300);
    const alexSpeaks = composeMotionFrame(plan, 1_300);
    const resting = '<line x1="-16" y1="26" x2="16" y2="26"/>';
    const count = (svg: string) => svg.split(resting).length - 1;
    expect(biaSpeaks).not.toBe(alexSpeaks);
    // Exactly one resting mouth in each frame: the listener's.
    expect(count(biaSpeaks)).toBe(1);
    expect(count(alexSpeaks)).toBe(1);
    expect(biaSpeaks.indexOf(resting)).toBeLessThan(biaSpeaks.indexOf("translate(780,1180)"));
    expect(alexSpeaks.indexOf(resting)).toBeGreaterThan(alexSpeaks.indexOf("translate(780,1180)"));
  });
});

describe("review regressions (slice 32)", () => {
  it("refuses a line that runs past its scene, and a reaction past its line", () => {
    const longer = { ...scene, toChar: 13 };
    expect(
      checkDialogue({
        lines: [{ speakerKey: "bia", fromChar: 0, toChar: 26 }],
        scene: longer,
        sceneText: text.slice(0, 13),
        knownTokens: known,
      }),
    ).toBe("dialogue_coverage");
    const late = [
      lines[0],
      { ...lines[1], reactions: [{ reactorKey: "bia", atWord: 5, token: "DOUBLE_TAKE" as const }] },
      lines[2],
    ];
    expect(
      checkDialogue({
        lines: late as readonly DialogueLine[],
        scene,
        sceneText: text,
        knownTokens: known,
      }),
    ).toBe("dialogue_reaction_invalid");
  });

  it("keeps words in time order and one per token when an interruption lands after a word starts", () => {
    // Line 2 has a word starting in its last 300 ms and no trailing silence.
    const timeline = composeDialogueTimeline(lines, [
      {
        durationMs: 800,
        words: [
          { text: "Quanto", startMs: 0, endMs: 350 },
          { text: "custa", startMs: 400, endMs: 750 },
        ],
      },
      {
        durationMs: 800,
        words: [
          { text: "Custa", startMs: 0, endMs: 450 },
          { text: "pouco", startMs: 600, endMs: 800 },
        ],
      },
      { durationMs: 400, words: [{ text: "Sério", startMs: 0, endMs: 350 }] },
    ]);
    const starts = timeline.words.map((w) => w.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(timeline.words).toHaveLength(5);
    // The interruption lands at 500 ms into line 2, in silence between words: cut there,
    // and "pouco" (never heard) is pinned at zero length at the interruption.
    expect(timeline.edits[1]).toEqual({ trimMs: 500, duckFromMs: 500 });
    expect(timeline.words[3]).toEqual({ text: "pouco", startMs: 1_480, endMs: 1_480 });
  });

  it("keeps exact TTS timing in the plan and leaves cut words out of the captions", () => {
    const timeline = composeDialogueTimeline(lines, [
      {
        durationMs: 800,
        words: [
          { text: "Quanto", startMs: 0, endMs: 350 },
          { text: "custa", startMs: 400, endMs: 750 },
        ],
      },
      {
        durationMs: 800,
        words: [
          { text: "Custa", startMs: 0, endMs: 450 },
          { text: "pouco", startMs: 600, endMs: 800 },
        ],
      },
      { durationMs: 400, words: [{ text: "Sério", startMs: 0, endMs: 350 }] },
    ]);
    const plan = planMotion({
      scenes: [scene],
      timings: [
        {
          startMs: 0,
          endMs: 2_400,
          voiceStartMs: 0,
          voiceEndMs: timeline.durationMs,
          text,
          words: timeline.words,
        },
      ],
      characters: cast,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 2_400,
    });
    const captioned =
      plan.scenes[0]?.captions.flatMap((group) => group.words.map((w) => w.text)) ?? [];
    expect(captioned).toEqual(["Quanto", "custa", "Custa", "Sério"]);
    expect(plan.scenes[0]?.words.map((w) => w.startMs)).toEqual(
      timeline.words.map((w) => w.startMs),
    );
  });

  it("counts reactions against the scene's action limit", () => {
    const expressions = (count: number) =>
      Array.from({ length: count }, (_, k) => ({
        type: "expression" as const,
        atWord: k % 5,
        expression: "happy" as const,
      }));
    const busy = (reactions: DialogueLine["reactions"]): SceneSpec => ({
      ...scene,
      dialogue: [
        lines[0] as DialogueLine,
        { ...(lines[1] as DialogueLine), reactions },
        lines[2] as DialogueLine,
      ],
      actors: scene.actors.map((actor) => ({
        ...actor,
        actions: expressions(actor.characterKey === "alex" ? 6 : 4),
      })),
    });
    const payoff: SceneSpec = {
      ...scene,
      index: 2,
      purpose: "payoff",
      dialogue: undefined,
      fromChar: 34,
      toChar: 40,
      camera: { shot: "medium", movement: "none" },
      actors: [scene.actors[0] as SceneSpec["actors"][number]],
    };
    const check = (s: SceneSpec) =>
      validateSceneSpecs({
        scenes: [s, payoff],
        characters: cast,
        claims: [],
        renderer: "stickman_motion",
        language: "pt-BR",
        sceneTexts: [text, "e daí"],
      });
    expect(check(busy([]))).toEqual({ ok: true });
    expect(check(busy([{ reactorKey: "bia", atWord: 0, token: "SMALL_FLINCH" }]))).toMatchObject({
      ok: false,
      rejection: { reason: "actions_limit" },
    });
    expect(check(busy([{ reactorKey: "bia", atWord: 0, token: "DOUBLE_TAKE" }]))).toMatchObject({
      ok: false,
      rejection: { reason: "dialogue_reaction_invalid" },
    });
  });
});
