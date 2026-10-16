// apps/worker/src/commands/render-bench.ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
} from "@money-maker/core/explainer/explainer-context";
import { type MotionPlan, planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { configureBundledFonts } from "@money-maker/providers/media/fonts";
import {
  createStickmanMotionRenderer,
  type RenderTimings,
} from "@money-maker/providers/media/stickman-motion-renderer";

/**
 * Renders a fixed stickman storyboard outside the job queue so machines can be compared on the
 * same input: the seven-scene milk explainer (docs/product/experiments/2026-09-29-first-stickman-
 * explainer.md) repeated to length, 10 words per scene, narrated by a synthetic speech-like tone
 * (Kokoro is benchmarked separately by scripts/local-ai/tts-bench.py).
 */
const exec = promisify(execFile);

export const BENCH_CAST: readonly ExplainerCharacter[] = [
  {
    key: "alex",
    name: "Alex",
    role: "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  },
  {
    key: "bia",
    name: "Bia",
    role: "secondary",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffe9d6", accent: "#2f7de1" },
    accessory: "glasses",
  },
];

type Template = Readonly<{ text: string; spec: Omit<SceneSpec, "index" | "fromChar" | "toChar"> }>;
const still = { props: [], overlays: [], captionMode: "word" } as const;

const TEMPLATES: readonly Template[] = [
  {
    text: "Why does every supermarket put the milk at the back",
    spec: {
      ...still,
      purpose: "hook",
      background: "store",
      actors: [
        {
          characterKey: "alex",
          pose: "holding_phone",
          expression: "confused",
          position: "center",
          actions: [{ type: "enter", atWord: 0, from: "left", durationMs: 900 }],
        },
      ],
      props: [{ type: "milk_carton", position: "right" }],
      overlays: [{ text: "WHY AT THE BACK?", position: "top", emphasis: true }],
      camera: { shot: "medium", movement: "slow_zoom_in" },
      transition: "hard_cut",
    },
  },
  {
    text: "You only came in for one thing and a cart",
    spec: {
      ...still,
      purpose: "setup",
      background: "store",
      actors: [
        {
          characterKey: "alex",
          pose: "walking",
          expression: "neutral",
          position: "center",
          actions: [{ type: "walk_to", atWord: 3, to: "right", durationMs: 1200 }],
        },
      ],
      props: [{ type: "shopping_cart", position: "left" }],
      camera: { shot: "wide", movement: "pan_right" },
      transition: "fade",
    },
  },
  {
    text: "Trucks unload dairy straight into cold rooms behind the wall",
    spec: {
      ...still,
      purpose: "explanation",
      background: "plain",
      actors: [{ characterKey: "alex", pose: "pointing", expression: "neutral", position: "left" }],
      diagram: {
        kind: "flow",
        nodes: [
          { id: "truck", label: "Truck" },
          { id: "cold", label: "Cold room" },
          { id: "fridge", label: "Back fridge", icon: "milk_carton" },
        ],
        edges: [
          { from: "truck", to: "cold" },
          { from: "cold", to: "fridge" },
        ],
      },
      camera: { shot: "medium", movement: "none" },
      transition: "wipe",
    },
  },
  {
    text: "But there is a second reason and it is you",
    spec: {
      ...still,
      purpose: "escalation",
      background: "store",
      actors: [
        {
          characterKey: "alex",
          pose: "surprised",
          expression: "neutral",
          position: "center",
          actions: [{ type: "expression", atWord: 6, expression: "surprised" }],
        },
      ],
      overlays: [{ text: "REASON 2: YOU", position: "middle", emphasis: true }],
      camera: { shot: "close", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    text: "The walk passes bread snacks and offers before the fridge",
    spec: {
      ...still,
      purpose: "explanation",
      background: "grid",
      actors: [
        { characterKey: "alex", pose: "thinking", expression: "skeptical", position: "right" },
      ],
      diagram: {
        kind: "flow",
        nodes: [
          { id: "door", label: "Entrance" },
          { id: "bread", label: "Bread" },
          { id: "snacks", label: "Snacks" },
          { id: "milk", label: "Milk", icon: "milk_carton" },
        ],
        edges: [
          { from: "door", to: "bread" },
          { from: "bread", to: "snacks" },
          { from: "snacks", to: "milk" },
        ],
      },
      camera: { shot: "medium", movement: "slow_zoom_out" },
      transition: "fade",
    },
  },
  {
    text: "So the long walk sells more than the milk itself",
    spec: {
      ...still,
      purpose: "payoff",
      background: "store",
      actors: [
        {
          characterKey: "alex",
          pose: "celebrating",
          expression: "happy",
          position: "left",
          actions: [{ type: "jump", atWord: 2 }],
        },
        {
          characterKey: "bia",
          pose: "neutral",
          expression: "excited",
          position: "right",
          actions: [{ type: "react", atWord: 7, mark: "sparkle" }],
        },
      ],
      props: [{ type: "lightbulb", position: "top" }],
      camera: { shot: "wide", movement: "none" },
      transition: "wipe",
    },
  },
  {
    text: "Next time bring a list and walk straight back there",
    spec: {
      ...still,
      purpose: "loop",
      background: "kitchen",
      actors: [
        {
          characterKey: "alex",
          pose: "neutral",
          expression: "happy",
          position: "center",
          actions: [{ type: "pose", atWord: 5, pose: "pointing" }],
        },
      ],
      props: [{ type: "document", position: "right" }],
      camera: { shot: "medium", movement: "pan_left" },
      transition: "hard_cut",
    },
  },
];
const SCENE_TARGET_MS = 4_500;
const LEAD_IN_MS = 200;
const TAIL_MS = 300;

export type BenchPlan = Readonly<{
  plan: MotionPlan;
  scenes: readonly SceneSpec[];
  texts: readonly string[];
  voiceMs: number;
  voiceStartMs: readonly number[];
}>;

export const buildBenchPlan = (targetSeconds: number): BenchPlan => {
  if (!Number.isInteger(targetSeconds) || targetSeconds < 10 || targetSeconds > 180)
    throw new Error("bench_duration_invalid");
  const count = Math.ceil((targetSeconds * 1000) / SCENE_TARGET_MS);
  const sceneMs = Math.floor((targetSeconds * 1000) / count);
  const voiceMs = sceneMs - LEAD_IN_MS - TAIL_MS;
  const templates = Array.from(
    { length: count },
    (_, i) => TEMPLATES[i % TEMPLATES.length] as Template,
  );
  const texts = templates.map((template) => template.text);
  let cursor = 0;
  const scenes = templates.map((template, i): SceneSpec => {
    const fromChar = cursor;
    cursor += template.text.length + (i < count - 1 ? 1 : 0);
    return { ...template.spec, index: i + 1, fromChar, toChar: cursor };
  });
  const timings = texts.map((text, i) => {
    const startMs = i * sceneMs;
    const voiceStartMs = startMs + LEAD_IN_MS;
    const tokens = text.split(" ");
    const step = voiceMs / tokens.length;
    return {
      startMs,
      endMs: startMs + sceneMs,
      voiceStartMs,
      voiceEndMs: voiceStartMs + voiceMs,
      text,
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
  });
  return { plan, scenes, texts, voiceMs, voiceStartMs: timings.map((t) => t.voiceStartMs) };
};

export type RenderBenchResult = Readonly<{
  targetSeconds: number;
  scenes: number;
  videoDurationMs: number;
  fileBytes: number;
  qaVerdict: string;
  blockedChecks: readonly string[];
  outputPath: string;
  loadAvg1Before: number;
  /** RENDER_THREADS as given (ffmpeg threads and sharp concurrency); absent = defaults. */
  renderThreads?: number | undefined;
  /** Stage timings from the renderer (slice 12, B1). */
  timings: RenderTimings;
  /** STICKMAN_LAYER_CACHE for this run (slice 17, B2). */
  layerCache?: boolean | undefined;
}>;

export const renderBench = async (
  targetSeconds: number,
  outDir: string,
): Promise<RenderBenchResult> => {
  const loadAvg1Before = Math.round((loadavg()[0] ?? 0) * 100) / 100;
  configureBundledFonts();
  const bench = buildBenchPlan(targetSeconds);
  const dir = await mkdtemp(join(tmpdir(), "render-bench-"));
  try {
    const tone = join(dir, "voice.wav");
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=180:duration=${bench.voiceMs / 1000},volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame`,
      "-ar",
      "24000",
      tone,
    ]);
    const clip = new Uint8Array(await readFile(tone));
    const threads = process.env.RENDER_THREADS ? Number(process.env.RENDER_THREADS) : undefined;
    const layerCache = ["1", "true"].includes(process.env.STICKMAN_LAYER_CACHE ?? "");
    const output = await createStickmanMotionRenderer({
      timeoutMs: 540_000,
      ...(threads ? { threads } : {}),
      ...(layerCache ? { layerCache } : {}),
    }).render({
      plan: bench.plan,
      voiceClips: bench.scenes.map(() => clip),
      voiceStartMs: bench.voiceStartMs,
    });
    await mkdir(outDir, { recursive: true });
    const outputPath = join(outDir, `render-${targetSeconds}s.mp4`);
    await writeFile(outputPath, output.bytes);
    return {
      targetSeconds,
      scenes: bench.scenes.length,
      videoDurationMs: output.durationMs,
      fileBytes: output.bytes.byteLength,
      qaVerdict: output.quality?.verdict ?? "n/a",
      blockedChecks:
        output.quality?.checks
          .filter((check) => check.verdict === "block")
          .map((check) => check.id) ?? [],
      outputPath,
      loadAvg1Before,
      renderThreads: threads,
      layerCache,
      timings: output.timings,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export type TimeUsage = Readonly<{ wallS: number; userS: number; sysS: number; peakRssMb: number }>;

/** Reads macOS `/usr/bin/time -l` or GNU `/usr/bin/time -v` output. Peak RSS is the largest single process (node or ffmpeg), not their sum. */
export const parseTimeOutput = (text: string): TimeUsage => {
  const mac = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(text);
  if (mac) {
    const rss = /(\d+)\s+maximum resident set size/.exec(text);
    if (!rss) throw new Error("time_output_unrecognized");
    return {
      wallS: Number(mac[1]),
      userS: Number(mac[2]),
      sysS: Number(mac[3]),
      peakRssMb: Math.round(Number(rss[1]) / 1_048_576),
    };
  }
  const user = /User time \(seconds\): ([\d.]+)/.exec(text);
  const sys = /System time \(seconds\): ([\d.]+)/.exec(text);
  const wall = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)/.exec(text);
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(text);
  if (!user || !sys || !wall || !rss) throw new Error("time_output_unrecognized");
  const wallS = (wall[1] ?? "").split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return {
    wallS: Math.round(wallS * 100) / 100,
    userS: Number(user[1]),
    sysS: Number(sys[1]),
    peakRssMb: Math.round(Number(rss[1]) / 1024),
  };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const benchRow = (input: {
  usage: TimeUsage;
  render: RenderBenchResult;
  machine: string;
  run: string;
  ffmpeg: string;
  now?: Date;
}) => ({
  machine: input.machine,
  run: input.run,
  date: (input.now ?? new Date()).toISOString(),
  targetSeconds: input.render.targetSeconds,
  scenes: input.render.scenes,
  videoDurationMs: input.render.videoDurationMs,
  wallS: input.usage.wallS,
  cpuS: round2(input.usage.userS + input.usage.sysS),
  userS: input.usage.userS,
  sysS: input.usage.sysS,
  peakRssMb: input.usage.peakRssMb,
  gpu: "none (libx264 on CPU)",
  fileBytes: input.render.fileBytes,
  qaVerdict: input.render.qaVerdict,
  blockedChecks: input.render.blockedChecks,
  valid: input.render.qaVerdict !== "block",
  loadAvg1Before: input.render.loadAvg1Before,
  renderThreads: input.render.renderThreads ?? null,
  layerCache: input.render.layerCache ?? false,
  timings: input.render.timings ?? null,
  host: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    totalMemGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
    ffmpeg: input.ffmpeg,
  },
});
export type BenchRow = ReturnType<typeof benchRow>;

const USAGE =
  "usage: render-bench.js render <seconds> [outDir] | merge <time.txt> <render.json> <machine> <run> [ffmpeg]";

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "render") {
    const [seconds, outDir = "render-bench-out"] = args;
    console.log(JSON.stringify(await renderBench(Number(seconds), outDir)));
    return;
  }
  if (command === "merge") {
    const [timeFile, renderFile, machine, run, ffmpeg = "unknown"] = args;
    if (!timeFile || !renderFile || !machine || !run) throw new Error(USAGE);
    const usage = parseTimeOutput(await readFile(timeFile, "utf8"));
    const render = JSON.parse(await readFile(renderFile, "utf8")) as RenderBenchResult;
    console.log(JSON.stringify(benchRow({ usage, render, machine, run, ffmpeg })));
    return;
  }
  throw new Error(USAGE);
};

if (process.argv[1]?.endsWith("render-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "render bench failed");
    process.exitCode = 1;
  });
}
