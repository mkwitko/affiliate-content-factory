import { createSceneSpecSchema } from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "../explainer-context.js";
import { EXPRESSIONS, poseAngles, renderStickmanFrame } from "../rigs/stick-v1.js";
import { STICK_V1_CATALOG } from "../scene-director.js";
import { SCENE_PURPOSES, type SceneSpec } from "../scene-spec.js";
import { composeMotionFrame, mouthShapeFor } from "./frame.js";
import { type MotionSceneTiming, planMotion } from "./plan.js";

const palette = { line: "#161616", fill: "#ffffff", accent: "#ff5a36" };
const face = (expression: (typeof EXPRESSIONS)[number]) =>
  renderStickmanFrame({
    angles: poseAngles("neutral"),
    expression,
    palette,
    x: 540,
    baselineY: 1180,
  });

describe("expression presets", () => {
  it("adds five presets, each with its own face", () => {
    expect(EXPRESSIONS).toHaveLength(14);
    const faces = new Set(EXPRESSIONS.map(face));
    expect(faces.size).toBe(EXPRESSIONS.length);
  });

  it("are accepted by the shared SceneSpec schema", () => {
    const schema = createSceneSpecSchema({ purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG });
    const actor = {
      characterKey: "alex",
      pose: "neutral",
      expression: "embarrassed",
      position: "center",
    };
    const scene = {
      index: 1,
      fromChar: 0,
      toChar: 5,
      purpose: "hook",
      background: "plain",
      actors: [actor],
      props: [],
      overlays: [],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
      captionMode: "word",
    };
    expect(schema.safeParse(scene).success).toBe(true);
  });
});

describe("mouthShapeFor", () => {
  const words = [
    { text: "mamãe", startMs: 0, endMs: 600 },
    { text: "viu", startMs: 650, endMs: 1_000 },
    { text: "o", startMs: 1_050, endMs: 1_300 },
  ];
  const shapes = Array.from({ length: 40 }, (_, frame) =>
    mouthShapeFor(words, (frame * 1000) / 30, 116),
  );

  it("changes at most 12 times a second and holds each shape at least 2 frames", () => {
    const changes = shapes.filter((shape, i) => i > 0 && shape !== shapes[i - 1]).length;
    expect(changes).toBeLessThanOrEqual(12 * (40 / 30));
    let run = 1;
    const runs: number[] = [];
    shapes.forEach((shape, i) => {
      if (i === 0) return;
      if (shape === shapes[i - 1]) run += 1;
      else {
        runs.push(run);
        run = 1;
      }
    });
    expect(Math.min(...runs.slice(1))).toBeGreaterThanOrEqual(2);
  });

  it("closes on m/b/p, rounds on o/u, widens on i/e, drops WIDE under 60 px", () => {
    expect(mouthShapeFor(words, 10, 116)).toBe("CLOSED");
    expect(mouthShapeFor(words, 1_100, 116)).toBe("ROUND");
    expect(new Set(shapes)).toContain("WIDE");
    const small = Array.from({ length: 40 }, (_, f) => mouthShapeFor(words, (f * 1000) / 30, 50));
    expect(new Set(small).has("WIDE")).toBe(false);
    expect(mouthShapeFor(words, 2_000, 116)).toBe("CLOSED");
  });
});

describe("conversation gaze and swap blink (grammar on)", () => {
  const cast: ExplainerCharacter[] = [
    { key: "alex", name: "Alex", role: "main", rigId: "stick-v1", rigVersion: 1, palette },
    { key: "bia", name: "Bia", role: "secondary", rigId: "stick-v1", rigVersion: 1, palette },
  ];
  const timing: MotionSceneTiming = {
    startMs: 0,
    endMs: 4_000,
    voiceStartMs: 200,
    voiceEndMs: 3_000,
    text: "um dois tres quatro cinco",
    words: ["um", "dois", "tres", "quatro", "cinco"].map((text, i) => ({
      text,
      startMs: 200 + i * 560,
      endMs: 700 + i * 560,
    })),
  };
  const scene: SceneSpec = {
    index: 1,
    fromChar: 0,
    toChar: 25,
    purpose: "hook",
    background: "plain",
    actors: [
      { characterKey: "alex", pose: "neutral", expression: "neutral", position: "left" },
      {
        characterKey: "bia",
        pose: "neutral",
        expression: "neutral",
        position: "right",
        actions: [{ type: "expression", atWord: 3, expression: "smug" }],
      },
    ],
    props: [],
    overlays: [],
    camera: { shot: "medium", movement: "none" },
    transition: "hard_cut",
    captionMode: "none",
  };
  const plan = (motionGrammar: boolean) =>
    planMotion({
      scenes: [scene],
      timings: [timing],
      characters: cast,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 4_000,
      motionGrammar,
    });

  it("turns a listener's eyes to the narrator while words are spoken", () => {
    // Bia stands right of alex, so her eyes shift toward -x (she faces right: gaze x negative).
    const speaking = composeMotionFrame(plan(true), 900);
    const silent = composeMotionFrame(plan(true), 3_700);
    expect(speaking).not.toBe(composeMotionFrame(plan(false), 900));
    expect(speaking).not.toBe(silent);
  });

  it("closes the eyes across an expression swap", () => {
    const swapAt = plan(true).scenes[0]?.actors[1]?.actions[0]?.startMs ?? 0;
    const mid = composeMotionFrame(plan(true), swapAt);
    expect(mid).toMatch(/ry="1"/);
  });
});
