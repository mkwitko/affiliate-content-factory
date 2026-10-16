import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFfmpegOwnedClipRenderer } from "./ffmpeg-owned-clip-renderer.js";

const execFileAsync = promisify(execFile);
const ffmpegAvailable = await execFileAsync("ffmpeg", ["-version"])
  .then(() => true)
  .catch(() => false);

describe.skipIf(!ffmpegAvailable)("createFfmpegOwnedClipRenderer", () => {
  it("burns aligned word captions into vertical clips", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owned-clip-test-"));
    const sourcePath = join(directory, "source.mp4");
    try {
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=360x640:r=30:d=2",
        "-c:v",
        "mpeg4",
        sourcePath,
      ]);
      const sourceBytes = new Uint8Array(await readFile(sourcePath));
      const output = await createFfmpegOwnedClipRenderer({ timeoutMs: 30_000 }).render({
        sourceBytes,
        startMs: 0,
        endMs: 2000,
        width: 360,
        height: 640,
        layout: "vertical",
        captionWords: [{ text: "A useful answer", startMs: 250, endMs: 1250 }],
      });

      expect(output).toMatchObject({ mimeType: "video/mp4", width: 1080, height: 1920 });
      expect(output.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // Real ffmpeg: left half red, right half blue landscape source, 6 s.
  const withSource = async (run: (source: Uint8Array) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), "owned-clip-layout-"));
    const sourcePath = join(directory, "source.mp4");
    try {
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=640x720:r=30:d=6",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=640x720:r=30:d=6",
        "-filter_complex",
        "[0:v][1:v]hstack",
        "-c:v",
        "mpeg4",
        sourcePath,
      ]);
      await run(new Uint8Array(await readFile(sourcePath)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const pixel = async (bytes: Uint8Array, atSec: number, x: number, y: number) => {
    const directory = await mkdtemp(join(tmpdir(), "owned-clip-pixel-"));
    try {
      const path = join(directory, "clip.mp4");
      await writeFile(path, bytes);
      const { stdout } = await execFileAsync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          String(atSec),
          "-i",
          path,
          "-frames:v",
          "1",
          "-vf",
          `crop=8:8:${x}:${y},scale=1:1`,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ],
        { encoding: "buffer" },
      );
      return [...stdout];
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  it("fills a landscape frame with a blurred copy (no black bars) and keeps captions working", async () => {
    await withSource(async (sourceBytes) => {
      const output = await createFfmpegOwnedClipRenderer({ timeoutMs: 60_000 }).render({
        sourceBytes,
        startMs: 0,
        endMs: 2000,
        width: 1280,
        height: 720,
        layout: "vertical_blur",
        captionWords: [{ text: "A useful answer", startMs: 250, endMs: 1250 }],
      });
      expect(output).toMatchObject({ width: 1080, height: 1920 });
      const top = await pixel(output.bytes, 0.5, 540, 20);
      expect(Math.max(...top)).toBeGreaterThan(60); // blurred red/blue, not black
    });
  }, 60_000);

  it("moves the crop window at scene cuts in source time for vertical_focus", async () => {
    await withSource(async (sourceBytes) => {
      const output = await createFfmpegOwnedClipRenderer({ timeoutMs: 60_000 }).render({
        sourceBytes,
        startMs: 2000,
        endMs: 6000,
        width: 1280,
        height: 720,
        layout: "vertical_focus",
        focusTrack: {
          cropWidth: 404,
          points: [
            { tMs: 0, x: 0 },
            { tMs: 3000, x: 876 },
          ],
        },
      });
      expect(output).toMatchObject({ width: 1080, height: 1920 });
      const before = await pixel(output.bytes, 0.5, 540, 960);
      const after = await pixel(output.bytes, 2, 540, 960);
      expect(before[0]).toBeGreaterThan(150); // red
      expect(before[2]).toBeLessThan(100);
      expect(after[2]).toBeGreaterThan(150); // blue
      expect(after[0]).toBeLessThan(100);
    });
  }, 60_000);
});
