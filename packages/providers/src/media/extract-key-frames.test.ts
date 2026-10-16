import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { extractKeyFrames } from "./extract-key-frames.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("extractKeyFrames", () => {
  it("returns one 720x1280 PNG per time and cleans its temp directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kf-test-"));
    const root = await mkdtemp(join(tmpdir(), "kf-root-"));
    try {
      const file = join(dir, "in.mp4");
      const made = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=270x480:rate=10",
        "-t",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-y",
        file,
      ]);
      expect(made.status).toBe(0);
      const frames = await extractKeyFrames(new Uint8Array(await readFile(file)), [200, 1500], {
        tmpRoot: root,
      });
      expect(frames).toHaveLength(2);
      for (const png of frames) {
        const meta = await sharp(Buffer.from(png)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["png", 720, 1280]);
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a file that is not a video", async () => {
    await expect(extractKeyFrames(new Uint8Array([1, 2, 3]), [0])).rejects.toThrow(
      "process_failed",
    );
  });
});
