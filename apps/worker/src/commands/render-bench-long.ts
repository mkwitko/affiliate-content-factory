// apps/worker/src/commands/render-bench-long.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import type { Location } from "@money-maker/core/explainer/locations";
import { planChunks } from "@money-maker/core/explainer/motion/chunks";
import { type MotionPlan, planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { configureBundledFonts } from "@money-maker/providers/media/fonts";
import { createStickmanMotionRenderer } from "@money-maker/providers/media/stickman-motion-renderer";
import { BENCH_CAST } from "./render-bench.js";

/**
 * Deterministic landscape long-form render for `pnpm render-bench:long` (default 10 minutes,
 * `--seconds=N` for a short run). Synthetic scenes cycle registry layouts, every diagram kind
 * and a location, narrated by a generated tone, and go through the same chunked renderer the
 * worker uses. Prints one JSON object; peak RSS is this node process (ffmpeg children excluded).
 */
const exec = promisify(execFile);
const SCENE_MS = 6_000;
const LEAD_IN_MS = 200;
const TAIL_MS = 300;
const TEXT = "Every step in this process changes the final number you pay at checkout";

export const LOCATION: Location = {
  id: "bench_office",
  version: 1,
  name: "Bench office",
  plate: { overscan: 1.12 },
  proceduralFallback: "office",
  zones: [
    {
      id: "desk",
      crop: { cx: 0.5, cy: 0.5, zoom: 1 },
      allowedShots: ["medium", "wide"],
      maxActors: 2,
      layouts: ["WIDE_ENVIRONMENT"],
    },
  ],
  anchors: [],
};

type Template = Omit<SceneSpec, "index" | "fromChar" | "toChar">;
export const base = {
  purpose: "explanation",
  background: "grid",
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "slow_zoom_in" },
  transition: "hard_cut",
  captionMode: "word",
} as const;
export const actor = (
  position: "left" | "center" | "right",
  key = "alex",
  pose: "neutral" | "pointing" = "neutral",
) => ({ characterKey: key, pose, expression: "happy", position }) as const;

const TEMPLATES: readonly Template[] = [
  { ...base, purpose: "hook", layoutId: "SOLO_CENTER", actors: [actor("center")] },
  {
    ...base,
    layoutId: "TWO_SHOT",
    camera: { shot: "two_shot", movement: "none" },
    actors: [actor("left"), actor("right", "bia")],
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("left")],
    diagram: {
      kind: "flow",
      nodes: [
        { id: "a", label: "Order" },
        { id: "b", label: "Fee" },
        { id: "c", label: "Total" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    },
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("right")],
    diagram: { kind: "counter", from: 0, to: 100, unit: "%" },
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("center")],
    diagram: {
      kind: "bar_compare",
      items: [
        { label: "Before", value: 40 },
        { label: "After", value: 70 },
      ],
    },
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("left")],
    diagram: { kind: "before_after", before: "Guess", after: "Know" },
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("right")],
    diagram: {
      kind: "timeline",
      points: [
        { label: "Order", at: "Day 1" },
        { label: "Ship", at: "Day 3" },
      ],
    },
  },
  {
    ...base,
    layoutId: "ACTOR_DIAGRAM_SPLIT",
    actors: [actor("center")],
    diagram: { kind: "percent", value: 65, label: "of orders" },
  },
  {
    ...base,
    layoutId: "ACTOR_LEFT_PROP_RIGHT",
    actors: [actor("left", "alex", "pointing")],
    props: [{ type: "document", position: "right" }],
    overlays: [{ text: "READ THIS", position: "top", emphasis: true }],
  },
  {
    ...base,
    purpose: "payoff",
    layoutId: "ACTOR_RIGHT_TEXT_LEFT",
    actors: [actor("right")],
    overlays: [{ text: "THE POINT", position: "middle" }],
  },
  {
    ...base,
    background: "office",
    layoutId: "WIDE_ENVIRONMENT",
    locationId: LOCATION.id,
    zoneId: "desk",
    camera: { shot: "wide", movement: "pan_left" },
    actors: [actor("left"), actor("center", "bia")],
  },
];

export const buildLongBenchPlan = (
  seconds: number,
): Readonly<{ plan: MotionPlan; voiceStartMs: readonly number[] }> => {
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3_600)
    throw new Error("bench_duration_invalid");
  const count = Math.max(1, Math.round((seconds * 1000) / SCENE_MS));
  const sceneMs = Math.floor((seconds * 1000) / count);
  const voiceMs = sceneMs - LEAD_IN_MS - TAIL_MS;
  const tokens = TEXT.split(" ");
  const step = voiceMs / tokens.length;
  let cursor = 0;
  const scenes = Array.from({ length: count }, (_, i): SceneSpec => {
    const fromChar = cursor;
    cursor += TEXT.length + 1;
    return {
      ...(TEMPLATES[i % TEMPLATES.length] as Template),
      index: i + 1,
      fromChar,
      toChar: cursor - 1,
    };
  });
  const timings = scenes.map((_scene, i) => {
    const startMs = i * sceneMs;
    const voiceStartMs = startMs + LEAD_IN_MS;
    return {
      startMs,
      endMs: startMs + sceneMs,
      voiceStartMs,
      voiceEndMs: voiceStartMs + voiceMs,
      text: TEXT,
      words: tokens.map((word, w) => ({
        text: word,
        startMs: Math.round(voiceStartMs + w * step),
        endMs: Math.round(voiceStartMs + (w + 1) * step - 40),
      })),
    };
  });
  const plan = planMotion({
    scenes,
    timings,
    characters: BENCH_CAST,
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: count * sceneMs,
    canvas: "landscape",
    locations: [LOCATION],
    variationSeed: "render-bench-long",
  });
  return { plan, voiceStartMs: timings.map((t) => t.voiceStartMs) };
};

export type LongBenchResult = Readonly<{
  targetSeconds: number;
  scenes: number;
  chunks: number;
  frames: number;
  durationMs: number;
  outputBytes: number;
  wallMs: number;
  composeMs: number;
  rasterMs: number;
  encodeMs: number;
  concatMs: number;
  fps: number;
  /** process.resourceUsage().maxRSS, this node process only. */
  peakRssMb: number;
  qaVerdict: string;
}>;

export const renderLongBench = async (
  seconds: number,
  chunkSeconds?: number,
): Promise<LongBenchResult> => {
  configureBundledFonts();
  const { plan, voiceStartMs } = buildLongBenchPlan(seconds);
  const dir = await mkdtemp(join(tmpdir(), "render-bench-long-"));
  try {
    const tone = join(dir, "voice.wav");
    const voiceMs = (plan.scenes[0]?.voiceEndMs ?? 0) - (plan.scenes[0]?.voiceStartMs ?? 0);
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=180:duration=${voiceMs / 1000},volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame`,
      "-ar",
      "24000",
      tone,
    ]);
    const clip = new Uint8Array(await readFile(tone));
    const threads = process.env.RENDER_THREADS ? Number(process.env.RENDER_THREADS) : undefined;
    const options = chunkSeconds ? { targetMs: chunkSeconds * 1000, minTotalMs: 0 } : undefined;
    const started = performance.now();
    const output = await createStickmanMotionRenderer({
      timeoutMs: 3_600_000,
      ...(threads ? { threads } : {}),
    }).render({
      plan,
      voiceClips: plan.scenes.map(() => clip),
      voiceStartMs,
      chunks: { sourceKey: "render-bench-long", rendererVersion: 0, codeVersion: "bench", options },
    });
    const wallMs = Math.round(performance.now() - started);
    const t = output.timings;
    return {
      targetSeconds: seconds,
      scenes: plan.scenes.length,
      chunks: t.chunks,
      frames: t.frames,
      durationMs: output.durationMs,
      outputBytes: output.bytes.byteLength,
      wallMs,
      composeMs: t.composeMs,
      rasterMs: t.rasterMs,
      encodeMs: t.encodeMs,
      concatMs: t.concatMs,
      fps: t.framesPerSec,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      qaVerdict: output.quality?.verdict ?? "n/a",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Chunks a run would use, without rendering; exported for tests. */
export const longBenchChunks = (seconds: number, chunkSeconds?: number): number =>
  planChunks(
    buildLongBenchPlan(seconds).plan,
    chunkSeconds ? { targetMs: chunkSeconds * 1000, minTotalMs: 0 } : {},
  ).length;

if (process.argv[1]?.endsWith("render-bench-long.js")) {
  const flag = (name: string): number | undefined => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? Number(arg.slice(name.length + 3)) : undefined;
  };
  void renderLongBench(flag("seconds") ?? 600, flag("chunk-seconds"))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "long render bench failed");
      process.exitCode = 1;
    });
}
