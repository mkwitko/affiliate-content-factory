import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_CLIP_FPS } from "@money-maker/core/assets/local-clip-profile";
import type { ClipProbe } from "@money-maker/core/home-worker/tasks";
import { RENDER_TEMP_PREFIX } from "./ffmpeg-reel-renderer.js";
import { runProcess } from "./run-process.js";

/** ffprobe/ffmpeg helpers for generated clips: probing posted video, h264 MP4 output, static plate clips. */
const TIMEOUT_MS = 120_000;
const EXT: Readonly<Record<string, string>> = { "video/mp4": "mp4", "video/webm": "webm" };

const inTempDir = async <T>(prefix: string, work: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), `${RENDER_TEMP_PREFIX}${prefix}-`));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Decodes every frame (-count_frames) so a truncated or corrupt stream shows up as stderr errors
 * or a short frame count. Never throws for bad input: it reports `readable: false`.
 */
export const probeVideo = async (bytes: Uint8Array, mimeType: string): Promise<ClipProbe> => {
  const bad: ClipProbe = {
    readable: false,
    hasVideo: false,
    width: 0,
    height: 0,
    frameCount: 0,
    durationMs: 0,
    decodeErrors: 0,
  };
  const ext = EXT[mimeType];
  if (!ext) return bad;
  return inTempDir("probe", async (dir) => {
    const path = join(dir, `in.${ext}`);
    await writeFile(path, bytes);
    try {
      const { stdout, stderr } = await runProcess(
        "ffprobe",
        [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,nb_read_frames,duration:format=duration",
          "-of",
          "json",
          path,
        ],
        { timeoutMs: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as {
        streams?: { width?: number; height?: number; nb_read_frames?: string; duration?: string }[];
        format?: { duration?: string };
      };
      const stream = parsed.streams?.[0];
      if (!stream) return { ...bad, readable: true };
      const frameCount = Number(stream.nb_read_frames ?? 0) || 0;
      const seconds = Number(stream.duration ?? parsed.format?.duration);
      return {
        readable: true,
        hasVideo: true,
        width: stream.width ?? 0,
        height: stream.height ?? 0,
        frameCount,
        // WebM from a streaming encoder may lack a duration: fall back to frames at the clip fps.
        durationMs: Number.isFinite(seconds)
          ? Math.round(seconds * 1000)
          : Math.round((frameCount / LOCAL_CLIP_FPS) * 1000),
        decodeErrors: stderr.split("\n").filter((line) => line.trim()).length,
      };
    } catch {
      return bad;
    }
  });
};

/** Re-encodes to h264/yuv420p MP4 without audio, the form the long-form renderer reads. */
export const transcodeToMp4 = async (bytes: Uint8Array, mimeType: string): Promise<Uint8Array> => {
  const ext = EXT[mimeType];
  if (!ext) throw new Error("clip_mime_unsupported");
  return inTempDir("transcode", async (dir) => {
    const input = join(dir, `in.${ext}`);
    const output = join(dir, "out.mp4");
    await writeFile(input, bytes);
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        input,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    return new Uint8Array(await readFile(output));
  });
};

/**
 * Heuristic flicker proxy for benchmarks: mean absolute luma difference (0-255) between
 * consecutive frames at 64x64. Not a quality score; null when fewer than two frames decode.
 */
export const meanFrameDiff = async (
  bytes: Uint8Array,
  mimeType: string,
): Promise<number | null> => {
  const ext = EXT[mimeType];
  if (!ext) return null;
  return inTempDir("framediff", async (dir) => {
    const input = join(dir, `in.${ext}`);
    const raw = join(dir, "out.raw");
    await writeFile(input, bytes);
    try {
      await runProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-v",
          "error",
          "-i",
          input,
          "-vf",
          "scale=64:64,format=gray",
          "-f",
          "rawvideo",
          raw,
        ],
        { timeoutMs: TIMEOUT_MS },
      );
    } catch {
      return null;
    }
    const data = await readFile(raw);
    const size = 64 * 64;
    const frames = Math.floor(data.length / size);
    if (frames < 2) return null;
    let total = 0;
    for (let f = 1; f < frames; f += 1) {
      let sum = 0;
      for (let i = 0; i < size; i += 1)
        sum += Math.abs((data[f * size + i] ?? 0) - (data[(f - 1) * size + i] ?? 0));
      total += sum / size;
    }
    return Math.round((total / (frames - 1)) * 1000) / 1000;
  });
};

/** A still plate as a slow zoom clip of the scene's length and canvas size (fallback_static). */
export const renderStaticZoomClip = async (input: {
  image: Uint8Array;
  width: number;
  height: number;
  seconds: number;
}): Promise<Uint8Array> => {
  const fps = 25;
  const frames = Math.max(1, Math.round(input.seconds * fps));
  return inTempDir("zoom", async (dir) => {
    const source = join(dir, "plate");
    const output = join(dir, "out.mp4");
    await writeFile(source, input.image);
    // Cover-fit at 2x first so the zoom steps stay sub-pixel smooth, then zoom 1.0 -> 1.12.
    const filter = [
      `scale=${input.width * 2}:${input.height * 2}:force_original_aspect_ratio=increase`,
      `crop=${input.width * 2}:${input.height * 2}`,
      `zoompan=z='1+0.12*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${input.width}x${input.height}:fps=${fps}`,
      "format=yuv420p",
    ].join(",");
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        source,
        "-vf",
        filter,
        "-frames:v",
        String(frames),
        "-an",
        "-c:v",
        "libx264",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    return new Uint8Array(await readFile(output));
  });
};
