import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMBIENT_LOOP_LIMITS,
  type AmbientLoopMeasure,
  BACKGROUND_ART_BOX,
} from "@money-maker/core/explainer/background-art";
import { runProcess } from "./run-process.js";

export type AmbientLoopOptions = Readonly<{
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  tmpRoot?: string;
}>;
/** QA frames: small and grey, so seam and motion are cheap mean differences in JS. */
const PROBE = { width: 108, height: 192 } as const;

const withClip = async <T>(
  bytes: Uint8Array,
  options: AmbientLoopOptions,
  work: (dir: string, clip: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "ambient-loop-"));
  try {
    const clip = join(dir, "clip.mp4");
    await writeFile(clip, bytes);
    return await work(dir, clip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const meanAbs = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / Math.max(1, a.length);
};

/** Size, length, mean frame-to-frame motion and the last-to-first seam of a loop clip. */
export const measureAmbientLoop = (
  bytes: Uint8Array,
  options: AmbientLoopOptions = {},
): Promise<AmbientLoopMeasure & Readonly<{ width: number; height: number }>> =>
  withClip(bytes, options, async (dir, clip) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const { stdout } = await runProcess(
      options.ffprobePath ?? "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        clip,
      ],
      { timeoutMs, signal: options.signal },
    );
    const stream = (JSON.parse(stdout) as { streams?: { width?: number; height?: number }[] })
      .streams?.[0];
    if (!stream?.width || !stream.height) throw new Error("ambient_loop_unreadable");
    const raw = join(dir, "frames.gray");
    await runProcess(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        clip,
        "-an",
        "-vf",
        `fps=${AMBIENT_LOOP_LIMITS.fps},scale=${PROBE.width}:${PROBE.height},format=gray`,
        // One frame past the limit, so an over-long clip measures as too long.
        "-frames:v",
        String(AMBIENT_LOOP_LIMITS.maxFrames + 1),
        "-f",
        "rawvideo",
        raw,
      ],
      { timeoutMs, signal: options.signal },
    );
    const data = new Uint8Array(await readFile(raw));
    const size = PROBE.width * PROBE.height;
    const frames = Array.from({ length: Math.floor(data.length / size) }, (_, i) =>
      data.subarray(i * size, (i + 1) * size),
    );
    const first = frames[0];
    const last = frames.at(-1);
    if (!first || !last || frames.length < 2) throw new Error("ambient_loop_unreadable");
    let motion = 0;
    for (let i = 1; i < frames.length; i += 1)
      motion += meanAbs(frames[i - 1] ?? first, frames[i] ?? first);
    return {
      width: stream.width,
      height: stream.height,
      durationMs: Math.round((frames.length * 1000) / AMBIENT_LOOP_LIMITS.fps),
      motion: motion / (frames.length - 1),
      seam: meanAbs(last, first),
    };
  });

/** The loop as JPEG frames at the art box size (cover-cropped), 30 fps, at most maxFrames. */
export const extractLoopFrames = (
  bytes: Uint8Array,
  options: AmbientLoopOptions = {},
): Promise<readonly Uint8Array[]> =>
  withClip(bytes, options, async (dir, clip) => {
    const { width, height } = BACKGROUND_ART_BOX;
    await runProcess(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        clip,
        "-an",
        "-vf",
        `fps=${AMBIENT_LOOP_LIMITS.fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
        "-frames:v",
        String(AMBIENT_LOOP_LIMITS.maxFrames),
        "-q:v",
        "4",
        join(dir, "f%04d.jpg"),
      ],
      { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal },
    );
    const names = (await readdir(dir)).filter((name) => /^f\d{4}\.jpg$/.test(name)).sort();
    if (names.length === 0) throw new Error("ambient_loop_unreadable");
    return Promise.all(names.map(async (name) => new Uint8Array(await readFile(join(dir, name)))));
  });
