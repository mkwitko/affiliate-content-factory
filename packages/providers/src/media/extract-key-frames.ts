import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./run-process.js";

/** Review size (spec 17.2): 720x1280, the 9:16 canvas the VLM sees. */
const FRAME = "scale=720:1280";

/**
 * One PNG per requested time from a rendered MP4 (what viewers see, captions and all). The
 * video comes from the asset store; nothing here touches the network or the database.
 */
export const extractKeyFrames = async (
  video: Uint8Array,
  timesMs: readonly number[],
  options: Readonly<{
    ffmpegPath?: string;
    timeoutMs?: number;
    tmpRoot?: string;
    signal?: AbortSignal;
  }> = {},
): Promise<readonly Uint8Array[]> => {
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "key-frames-"));
  try {
    const clip = join(dir, "render.mp4");
    await writeFile(clip, video);
    const frames: Uint8Array[] = [];
    for (const [index, timeMs] of timesMs.entries()) {
      const out = join(dir, `frame-${index}.png`);
      await runProcess(
        options.ffmpegPath ?? "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          (Math.max(0, timeMs) / 1000).toFixed(3),
          "-i",
          clip,
          "-frames:v",
          "1",
          "-vf",
          FRAME,
          "-y",
          out,
        ],
        { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal },
      );
      frames.push(new Uint8Array(await readFile(out)));
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
