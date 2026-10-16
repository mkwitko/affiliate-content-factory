import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "../explainer-context.js";
import type { SceneSpec } from "../scene-spec.js";
import {
  CHUNK_MIN_TOTAL_MS,
  chunkIdentity,
  frameCount,
  planChunks,
  type RenderChunk,
} from "./chunks.js";
import { type MotionPlan, planMotion } from "./plan.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
};
const scene = (index: number, text: string): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: text.length,
  purpose: "explanation",
  background: "store",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
});

/** `count` scenes of `sceneMs` each; scene texts differ so identities can tell them apart. */
const buildPlan = (count: number, sceneMs: number, wordsOf = (i: number) => `scene ${i} words`) => {
  const texts = Array.from({ length: count }, (_, i) => wordsOf(i));
  return planMotion({
    scenes: texts.map((text, i) => scene(i + 1, text)),
    timings: texts.map((text, i) => {
      const startMs = i * sceneMs;
      const tokens = text.split(" ");
      return {
        startMs,
        endMs: startMs + sceneMs,
        voiceStartMs: startMs + 200,
        voiceEndMs: startMs + sceneMs - 300,
        text,
        words: tokens.map((word, w) => ({
          text: word,
          startMs: startMs + 200 + w * 400,
          endMs: startMs + 200 + w * 400 + 360,
        })),
      };
    }),
    characters: [alex],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: count * sceneMs,
  });
};
const identity = (plan: MotionPlan, chunk: RenderChunk, over: { sourceKey?: string } = {}) =>
  chunkIdentity({
    plan,
    chunk,
    sourceKey: over.sourceKey ?? "board-1",
    rendererVersion: 1,
    codeVersion: "abc1234",
    width: 1080,
    height: 1920,
    layerCache: false,
  });

describe("planChunks", () => {
  const plan = buildPlan(30, 10_000); // 300 s
  const chunks = planChunks(plan);

  it("covers every frame exactly once, in order, with no gap or overlap", () => {
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.startFrame).toBe(0);
    expect(chunks.at(-1)?.endFrame).toBe(frameCount(plan));
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
      expect(chunk.endFrame).toBeGreaterThan(chunk.startFrame);
      if (i > 0) expect(chunk.startFrame).toBe(chunks[i - 1]?.endFrame);
    });
    expect(chunks.reduce((sum, chunk) => sum + chunk.endFrame - chunk.startFrame, 0)).toBe(
      frameCount(plan),
    );
  });

  it("cuts on scene starts and keeps each chunk near the target duration", () => {
    for (const chunk of chunks.slice(1)) {
      const opening = plan.scenes[chunk.sceneFrom];
      expect(chunk.startFrame).toBe(Math.ceil(((opening?.startMs ?? 0) * 30) / 1000));
    }
    // 10 s scenes against a 60 s target: six scenes per chunk, no scene split across chunks.
    expect(chunks.map((chunk) => chunk.sceneTo - chunk.sceneFrom + 1)).toEqual([6, 6, 6, 6, 6]);
    expect(chunks.map((chunk) => chunk.sceneFrom)).toEqual([0, 6, 12, 18, 24]);
  });

  it("is a pure function of the plan", () => {
    expect(planChunks(plan)).toEqual(planChunks(buildPlan(30, 10_000)));
  });

  it("keeps a short plan, and a plan of one scene, in a single pass", () => {
    expect(planChunks(buildPlan(10, 10_000))).toHaveLength(1);
    expect(CHUNK_MIN_TOTAL_MS).toBeGreaterThanOrEqual(120_000);
    expect(planChunks(buildPlan(1, 600_000))).toHaveLength(1);
  });

  it("honours explicit options for small tests and benches", () => {
    expect(planChunks(buildPlan(4, 2_000), { targetMs: 4_000, minTotalMs: 0 })).toHaveLength(2);
  });
});

describe("chunkIdentity", () => {
  const plan = buildPlan(30, 10_000);
  const chunks = planChunks(plan);
  const first = chunks[0] as RenderChunk;
  const last = chunks.at(-1) as RenderChunk;

  it("is stable across calls and across rebuilt equal plans", () => {
    expect(identity(plan, first)).toBe(identity(buildPlan(30, 10_000), first));
    expect(identity(plan, first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per chunk, storyboard, renderer version, canvas size and layer cache", () => {
    const all = new Set(chunks.map((chunk) => identity(plan, chunk)));
    expect(all.size).toBe(chunks.length);
    expect(identity(plan, first, { sourceKey: "board-2" })).not.toBe(identity(plan, first));
    const other = (over: Partial<Parameters<typeof chunkIdentity>[0]>) =>
      chunkIdentity({
        plan,
        chunk: first,
        sourceKey: "board-1",
        rendererVersion: 1,
        codeVersion: "abc1234",
        width: 1080,
        height: 1920,
        layerCache: false,
        ...over,
      });
    expect(other({ rendererVersion: 2 })).not.toBe(identity(plan, first));
    expect(other({ codeVersion: "def5678" })).not.toBe(identity(plan, first));
    expect(other({ width: 1920, height: 1080 })).not.toBe(identity(plan, first));
    expect(other({ layerCache: true })).not.toBe(identity(plan, first));
  });

  it("changes when narration or timing inside the chunk changes, not for a distant chunk", () => {
    const edited = buildPlan(30, 10_000, (i) =>
      i === 28 ? "scene changed words" : `scene ${i} words`,
    );
    expect(identity(edited, last)).not.toBe(identity(plan, last));
    for (const chunk of chunks.slice(0, -1))
      expect(identity(edited, chunk)).toBe(identity(plan, chunk));
  });
});
