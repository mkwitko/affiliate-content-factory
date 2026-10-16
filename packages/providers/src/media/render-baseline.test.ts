// packages/providers/src/media/render-baseline.test.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReelTimeline } from "@money-maker/core/assets/reel-timeline";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import { planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import {
  evaluateRenderQuality,
  type RenderQualityReport,
} from "@money-maker/core/publishing/render-quality";
import { createFfmpegOwnedClipRenderer } from "./ffmpeg-owned-clip-renderer.js";
import { createFfmpegReelRenderer } from "./ffmpeg-reel-renderer.js";
import { createStickmanMotionRenderer } from "./stickman-motion-renderer.js";
import { measureRenderedVideo } from "./video-quality-probe.js";

// Opt-in: RENDER_BASELINE=record rewrites render-baseline.json, RENDER_BASELINE=check compares.
// Unset (pnpm check, CI) skips, because verdicts can differ between ffmpeg builds.
const mode = process.env.RENDER_BASELINE;
const baselinePath = new URL("./render-baseline.json", import.meta.url);
const run = promisify(execFile);

type Family = "stickman_motion" | "affiliate_reel" | "owned_clip";
type Summary = Readonly<{
  family: Family;
  width: number;
  height: number;
  durationMs: number;
  verdict: string;
  checks: Readonly<Record<string, string>>;
  wallMs: number;
}>;

const summarize = (
  family: Family,
  output: Readonly<{
    width: number;
    height: number;
    durationMs: number;
    quality?: RenderQualityReport | undefined;
  }>,
  startedAt: number,
): Summary => ({
  family,
  width: output.width,
  height: output.height,
  durationMs: output.durationMs,
  verdict: output.quality?.verdict ?? "unmeasured",
  checks: Object.fromEntries(
    (output.quality?.checks ?? []).map((check) => [check.id, check.verdict]),
  ),
  wallMs: Math.round(performance.now() - startedAt),
});

const alex = {
  key: "alex",
  name: "Alex",
  role: "main" as const,
  rigId: "stick-v1" as const,
  rigVersion: 1 as const,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const scene = (index: number, over: Partial<SceneSpec>): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: 1,
  purpose: "explanation",
  background: "store",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "center" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const timing = (startMs: number, text: string, voiceMs: number) => {
  const tokens = text.split(" ");
  const step = voiceMs / tokens.length;
  const words = tokens.map((word, i) => ({
    text: word,
    startMs: Math.round(startMs + 200 + i * step),
    endMs: Math.round(startMs + 200 + (i + 1) * step - 40),
  }));
  return {
    startMs,
    endMs: startMs + 200 + voiceMs + 300,
    voiceStartMs: startMs + 200,
    voiceEndMs: startMs + 200 + voiceMs,
    words,
    text,
  };
};

describe.skipIf(mode !== "record" && mode !== "check")("render baseline", () => {
  let dir: string;
  const tone = async (name: string, filter: string) => {
    const path = join(dir, name);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", filter, "-ar", "24000", path]);
    return new Uint8Array(await readFile(path));
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "render-baseline-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stickman = async (): Promise<Summary> => {
    const clip = await tone(
      "stickman.wav",
      "sine=frequency=180:duration=1.4,volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame",
    );
    const timings = [
      timing(0, "Why is milk at the back", 1_400),
      timing(1_900, "because you walk past", 1_400),
    ];
    const plan = planMotion({
      scenes: [
        scene(1, {
          purpose: "hook",
          overlays: [{ text: "WHY?", position: "top", emphasis: true }],
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "center",
              actions: [{ type: "enter", atWord: 0, from: "left", durationMs: 900 }],
            },
          ],
        }),
        scene(2, {
          purpose: "payoff",
          transition: "wipe",
          props: [{ type: "milk_carton", position: "right" }],
        }),
      ],
      timings,
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timings[1]?.endMs ?? 0,
    });
    const startedAt = performance.now();
    const output = await createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
      plan,
      voiceClips: [clip, clip],
      voiceStartMs: plan.scenes.map((entry) => entry.voiceStartMs),
    });
    return summarize("stickman_motion", output, startedAt);
  };

  const reel = async (): Promise<Summary> => {
    const clip = await tone(
      "reel.wav",
      "sine=frequency=180:duration=6,volume='if(lt(mod(t,1.2),0.9),1,0)':eval=frame",
    );
    const textured = async (seed: number) => ({
      bytes: new Uint8Array(
        await sharp({
          create: {
            width: 1080,
            height: 1350,
            channels: 3,
            background: { r: 120 + seed * 30, g: 90, b: 60 },
            noise: { type: "gaussian", mean: 128, sigma: 40 },
          },
        })
          .jpeg()
          .toBuffer(),
      ),
      mimeType: "image/jpeg" as const,
      width: 1080,
      height: 1350,
    });
    const timeline = buildReelTimeline({
      slideCount: 3,
      clips: [0, 1, 2].map(() => ({ durationMs: 6_000, words: [] })),
    });
    const slides = [await textured(0), await textured(1), await textured(2)];
    const startedAt = performance.now();
    const output = await createFfmpegReelRenderer({ timeoutMs: 120_000 }).render({
      slides,
      timeline,
      voiceClips: [clip, clip, clip],
      motions: ["ken_burns_in", "ken_burns_out", "static"],
    });
    return summarize("affiliate_reel", output, startedAt);
  };

  const ownedClip = async (): Promise<Summary> => {
    const sourcePath = join(dir, "source.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1920x1080:r=30:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      sourcePath,
    ]);
    const startedAt = performance.now();
    const output = await createFfmpegOwnedClipRenderer({ timeoutMs: 60_000 }).render({
      sourceBytes: new Uint8Array(await readFile(sourcePath)),
      startMs: 0,
      endMs: 3_000,
      width: 1920,
      height: 1080,
      layout: "vertical",
      captionWords: [{ text: "A useful answer", startMs: 250, endMs: 1250 }],
    });
    // The clip renderer has no quality gate of its own; grade it with the shared probe.
    const outputPath = join(dir, "clip.mp4");
    await writeFile(outputPath, output.bytes);
    const quality = evaluateRenderQuality(await measureRenderedVideo(outputPath), {
      width: output.width,
      height: output.height,
      fps: 30,
      durationMs: output.durationMs,
      audioRequired: true,
      plannedStill: [],
      plannedSilence: [],
      plannedDark: [],
    });
    return summarize("owned_clip", { ...output, quality }, startedAt);
  };

  it("records or matches dimensions, duration and QA verdicts for the three families", async () => {
    const results = [await stickman(), await reel(), await ownedClip()];
    const ffmpeg = (await run("ffmpeg", ["-version"])).stdout.split("\n")[0] ?? "";
    if (mode === "record") {
      await writeFile(baselinePath, `${JSON.stringify({ ffmpeg, results }, null, 2)}\n`);
      return;
    }
    const recorded = JSON.parse(await readFile(baselinePath, "utf8")) as {
      ffmpeg: string;
      results: Summary[];
    };
    const comparable = ({ durationMs: _duration, wallMs: _wall, ...rest }: Summary) => rest;
    expect(results.map(comparable)).toEqual(recorded.results.map(comparable));
    for (const [index, result] of results.entries())
      expect(
        Math.abs(result.durationMs - (recorded.results[index]?.durationMs ?? Number.NaN)),
      ).toBeLessThanOrEqual(100);
  }, 600_000);
});
