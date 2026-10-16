import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderCallOptions } from "@money-maker/core/assets/reel-renderer";
import { wavDurationMs } from "@money-maker/core/assets/wav-duration";
import { geometryFor } from "@money-maker/core/explainer/layout";
import {
  compositionFromPlan,
  visualTokensFor,
} from "@money-maker/core/explainer/hyperframes/composition";
import { RENDER_TEMP_PREFIX } from "./ffmpeg-reel-renderer.js";
import { fontFile } from "./fonts.js";
import { runProcess } from "./run-process.js";
import type {
  StickmanMotionRenderInput,
  StickmanMotionRenderOutput,
} from "./stickman-motion-renderer.js";

/**
 * EXPERIMENTAL second renderer for the same MotionPlan (spike, docs/experiments/hyperframes-
 * spike.md). Writes a temp HyperFrames project (index.html from the pure core mapper, narration
 * WAVs, bundled fonts) and runs the pinned CLI in it: no shell, telemetry and update checks off,
 * killed on timeout or abort, temp directory always removed. Nothing in production routes here.
 */
export const HYPERFRAMES_VERSION = "0.8.112";
/** Pinned npx call; HyperFrames is not a dependency of api or worker (see the spike doc). */
export const DEFAULT_HYPERFRAMES_CLI: readonly string[] = [
  "npx",
  "--yes",
  `hyperframes@${HYPERFRAMES_VERSION}`,
];
/** Set on every spawn: no telemetry, no update check. */
export const HYPERFRAMES_ENV = Object.freeze({
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
});

export type HyperFramesRenderTimings = Readonly<{
  /** Whole render call, project write and CLI run included. */
  totalMs: number;
  /** The CLI process alone. */
  cliMs: number;
  /** HyperFrames does not report its encode stage to the caller. */
  encodeMs: null;
}>;
export type HyperFramesRenderOutput = Omit<StickmanMotionRenderOutput, "timings"> &
  Readonly<{ timings: HyperFramesRenderTimings }>;

export const createHyperFramesRenderer = (
  options: Readonly<{
    cliCommand?: readonly string[];
    timeoutMs?: number;
    workers?: number;
    tmpRoot?: string;
    /** Extra environment for the CLI (for example PUPPETEER_EXECUTABLE_PATH). */
    env?: Readonly<Record<string, string>>;
  }> = {},
) => ({
  async render(
    input: StickmanMotionRenderInput,
    call?: RenderCallOptions,
  ): Promise<HyperFramesRenderOutput> {
    const started = performance.now();
    const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `${RENDER_TEMP_PREFIX}hf-`));
    try {
      await mkdir(join(dir, "fonts"));
      const fonts = ([400, 700, 800] as const).map((weight) => ({
        weight,
        src: `fonts/Inter-${weight}.ttf`,
      }));
      for (const font of fonts) await copyFile(fontFile(font.weight), join(dir, font.src));
      const audio = await Promise.all(
        input.voiceClips.map(async (clip, i) => {
          const src = `voice-${i}.wav`;
          await writeFile(join(dir, src), clip);
          return {
            src,
            startMs: input.voiceStartMs[i] ?? 0,
            durationMs: wavDurationMs(clip),
          };
        }),
      );
      await writeFile(
        join(dir, "index.html"),
        compositionFromPlan(input.plan, visualTokensFor(input.plan), { audio, fonts }),
      );
      const [command, ...pinned] = options.cliCommand ?? DEFAULT_HYPERFRAMES_CLI;
      const output = join(dir, "out.mp4");
      const cliStarted = performance.now();
      try {
        await runProcess(
          command as string,
          [
            ...pinned,
            "render",
            "--output",
            output,
            "--fps",
            String(input.plan.fps),
            "--quality",
            "standard",
            "--quiet",
            ...(options.workers ? ["--workers", String(options.workers)] : []),
          ],
          {
            cwd: dir,
            env: { ...process.env, ...options.env, ...HYPERFRAMES_ENV },
            timeoutMs: options.timeoutMs ?? 600_000,
            signal: call?.signal,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "render_aborted") throw error;
        const code = message.startsWith("process_failed:")
          ? message.slice("process_failed:".length)
          : message === "process_timeout"
            ? "timeout"
            : "unknown";
        throw new Error(`hyperframes_render_failed:${code}`);
      }
      const cliMs = Math.round(performance.now() - cliStarted);
      const bytes = new Uint8Array(await readFile(output));
      const geo = geometryFor(input.plan.canvas);
      return {
        bytes,
        mimeType: "video/mp4",
        width: geo.frame.width,
        height: geo.frame.height,
        durationMs: input.plan.durationMs,
        timings: {
          totalMs: Math.round(performance.now() - started),
          cliMs,
          encodeMs: null,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
