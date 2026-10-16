import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { composeDialogueTimeline, type DialogueLine } from "@money-maker/core/explainer/dialogue";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
} from "@money-maker/core/explainer/explainer-context";
import { planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMotionAudioArgs, createStickmanMotionRenderer } from "./stickman-motion-renderer.js";

const run = promisify(execFile);
const palette = { line: "#161616", fill: "#ffffff", accent: "#ff5a36" };
const cast: ExplainerCharacter[] = [
  { key: "alex", name: "Alex", role: "main", rigId: "stick-v1", rigVersion: 1, palette },
  { key: "bia", name: "Bia", role: "secondary", rigId: "stick-v1", rigVersion: 1, palette },
  { key: "rafa", name: "Rafa", role: "secondary", rigId: "stick-v1", rigVersion: 1, palette },
];

describe("buildMotionAudioArgs with dialogue edits", () => {
  it("trims and ducks an interrupted clip before placing it", () => {
    const args = buildMotionAudioArgs({
      videoPath: "v.mp4",
      voicePaths: ["a.wav", "b.wav"],
      voiceStartMs: [0, 900],
      voiceEdits: [{ trimMs: 750, duckFromMs: 500 }, undefined],
      sfxPaths: {},
      cues: [],
      durationMs: 2_000,
      outputPath: "o.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain(
      "[1:a]atrim=end=0.750,volume=-10dB:enable='gte(t\\,0.500)',adelay=delays=0:all=1[vo0]",
    );
    expect(graph).toContain("[2:a]adelay=delays=900:all=1[vo1]");
  });
});

describe("dialogue renders (real ffmpeg)", () => {
  let dir: string;
  const tone: Record<number, Uint8Array> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dialogue-"));
    for (const [i, freq] of [180, 240, 300].entries()) {
      const path = join(dir, `v${i}.wav`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${freq}:duration=0.9`,
        "-ar",
        "24000",
        path,
      ]);
      tone[i] = new Uint8Array(await readFile(path));
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const render = async (
    speakers: readonly string[],
    text: string,
    lines: readonly DialogueLine[],
  ) => {
    const clips = lines.map(() => ({
      durationMs: 900,
      words: [
        { text: "w", startMs: 0, endMs: 400 },
        { text: "w", startMs: 450, endMs: 850 },
      ],
    }));
    const timeline = composeDialogueTimeline(lines, clips);
    const scene: SceneSpec = {
      index: 1,
      fromChar: 0,
      toChar: text.length,
      purpose: "hook",
      background: "office",
      actors: speakers.map((key, i) => ({
        characterKey: key,
        pose: "neutral",
        expression: "neutral",
        position: (["left", "right", "center"] as const)[i] ?? "center",
      })),
      props: [],
      overlays: [],
      camera: { shot: "wide", movement: "none" },
      transition: "hard_cut",
      captionMode: "word",
      dialogue: lines,
    };
    const voiceStart = 200;
    const plan = planMotion({
      scenes: [scene],
      timings: [
        {
          startMs: 0,
          endMs: voiceStart + timeline.durationMs + 300,
          voiceStartMs: voiceStart,
          voiceEndMs: voiceStart + timeline.durationMs,
          text,
          words: timeline.words.map((w) => ({
            ...w,
            startMs: w.startMs + voiceStart,
            endMs: w.endMs + voiceStart,
          })),
        },
      ],
      characters: cast,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 2,
      durationMs: voiceStart + timeline.durationMs + 300,
      motionGrammar: true,
    });
    return createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
      plan,
      voiceClips: lines.map((_line, i) => tone[i % 3] as Uint8Array),
      voiceStartMs: timeline.startsMs.map((ms) => ms + voiceStart),
      voiceEdits: timeline.edits,
    });
  };

  it("renders a two-character exchange with an interruption that passes the quality gate", async () => {
    const text = "aa bb cc dd ee ff";
    const output = await render(["alex", "bia"], text, [
      { speakerKey: "alex", fromChar: 0, toChar: 5 },
      { speakerKey: "bia", fromChar: 6, toChar: 11 },
      { speakerKey: "alex", fromChar: 12, toChar: 17, interruptsPrev: true },
    ]);
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
  }, 180_000);

  it("renders a three-character scene that passes the quality gate", async () => {
    const text = "aa bb cc dd ee ff";
    const output = await render(["alex", "bia", "rafa"], text, [
      { speakerKey: "alex", fromChar: 0, toChar: 5 },
      {
        speakerKey: "bia",
        fromChar: 6,
        toChar: 11,
        reactions: [{ reactorKey: "rafa", atWord: 0, token: "SMALL_FLINCH" }],
      },
      { speakerKey: "rafa", fromChar: 12, toChar: 17, pauseBeforeMs: 400 },
    ]);
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
  }, 180_000);
});
