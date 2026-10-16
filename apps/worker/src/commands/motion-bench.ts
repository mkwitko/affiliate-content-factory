import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  KEN_BURNS_MOTION,
  PARALLAX_MOTION,
  PARALLAX_SOFT_MOTION,
  renderParallaxClip,
} from "@money-maker/providers/media/parallax-clip";
import { type ArenaRunSpec, buildJudgePage, parseArenaRunSpec } from "./arena.js";

/**
 * `pnpm motion-bench <scenesDir> <runDir>`: Ken Burns vs 2.5D parallax on the same stills
 * (docs/content-generation/experiments.md, motion tiers). Every `<name>.png` with a
 * `<name>.depth.png` (scripts/local-ai/depth.py) becomes `kb/<name>.mp4` and `px/<name>.mp4`
 * from one renderer that differs only in the depth motion, plus a blind judge page
 * (`pnpm ai:arena report <runDir>` after the owner saves judgments-human.json).
 */
export const MOTION_ARENA = {
  task: "motion.scene",
  champion: "ken_burns",
  candidates: [
    { id: "ken_burns", dir: "kb", motion: KEN_BURNS_MOTION },
    { id: "parallax_2_5d", dir: "px", motion: PARALLAX_MOTION },
    { id: "parallax_2_5d_soft", dir: "pxs", motion: PARALLAX_SOFT_MOTION },
  ],
} as const;

export const motionSpec = (caseIds: readonly string[]): ArenaRunSpec =>
  parseArenaRunSpec({
    task: MOTION_ARENA.task,
    champion: MOTION_ARENA.champion,
    candidates: MOTION_ARENA.candidates.map(({ id, dir }) => ({ id, dir })),
    media: { kind: "video", ext: "mp4" },
    cases: caseIds.map((caseId) => ({
      caseId,
      brief: "Same scene, same zoom. Which motion looks better in a Reel, without distortion?",
    })),
  });

const flag = (args: readonly string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const main = async () => {
  const [scenesDir, runDir, ...args] = process.argv.slice(2);
  if (!scenesDir || !runDir)
    throw new Error(
      "usage: motion-bench.js <scenesDir> <runDir> [--duration=4] [--size=1080x1350]",
    );
  const [width, height] = (flag(args, "size") ?? "1080x1350").split("x").map(Number);
  const durationSec = Number(flag(args, "duration") ?? 4);
  if (!width || !height || !(durationSec > 0 && durationSec <= 10))
    throw new Error("motion_bench_args_invalid");
  const files = await readdir(scenesDir);
  const caseIds = files
    .filter((f) => f.endsWith(".png") && !f.endsWith(".depth.png"))
    .map((f) => basename(f, ".png"))
    .filter((id) => /^[\w.-]+$/.test(id) && files.includes(`${id}.depth.png`));
  if (caseIds.length === 0) throw new Error("no <name>.png with <name>.depth.png in scenesDir");
  for (const caseId of caseIds) {
    const scene = await readFile(join(scenesDir, `${caseId}.png`));
    const depth = await readFile(join(scenesDir, `${caseId}.depth.png`));
    for (const { dir, motion } of MOTION_ARENA.candidates) {
      await mkdir(join(runDir, dir), { recursive: true });
      const started = performance.now();
      await renderParallaxClip({
        scene,
        depth,
        motion,
        width,
        height,
        durationSec,
        outputPath: join(runDir, dir, `${caseId}.mp4`),
      });
      console.log(`${dir}/${caseId}.mp4 ${Math.round(performance.now() - started)} ms`);
    }
  }
  const spec = motionSpec(caseIds);
  await writeFile(join(runDir, "arena.json"), JSON.stringify(spec, null, 1));
  const available = new Set(
    MOTION_ARENA.candidates.flatMap(({ dir }) => caseIds.map((id) => `${dir}/${id}.mp4`)),
  );
  await writeFile(join(runDir, "judge.html"), buildJudgePage(spec, available, Date.now() % 1e9));
  console.log(join(runDir, "judge.html"));
};

if (process.argv[1]?.endsWith("motion-bench.js"))
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
