import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ambientLoopVerdict } from "@money-maker/core/explainer/background-art";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractLoopFrames, measureAmbientLoop } from "./ambient-loop.js";

const run = promisify(execFile);
/** 2 s, 216x384, 30 fps test clips: a 2 s period loops seamlessly, a 4 s period does not. */
const SOURCES = {
  seamless:
    "color=c=gray:s=216x384:r=30:d=2,format=yuv420p,geq=lum='128+60*sin(2*PI*(X/216+T/2))':cb=128:cr=128",
  seam: "color=c=gray:s=216x384:r=30:d=2,format=yuv420p,geq=lum='128+60*sin(2*PI*(X/216+T/4))':cb=128:cr=128",
  frozen: "color=c=gray:s=216x384:r=30:d=2",
} as const;

describe("ambient loops (real ffmpeg)", () => {
  let dir: string;
  const clips: Partial<Record<keyof typeof SOURCES, Uint8Array>> = {};
  const clip = (name: keyof typeof SOURCES) => clips[name] ?? new Uint8Array();
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ambient-test-"));
    for (const [name, source] of Object.entries(SOURCES) as [keyof typeof SOURCES, string][]) {
      const path = join(dir, `${name}.mp4`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        source,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      clips[name] = new Uint8Array(await readFile(path));
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("measures motion and seam so a seamless loop passes and seams or freezes are blocked", async () => {
    const seamless = await measureAmbientLoop(clip("seamless"));
    expect(seamless).toMatchObject({ width: 216, height: 384, durationMs: 2_000 });
    expect(seamless.motion).toBeCloseTo(4.6, 0);
    expect(ambientLoopVerdict(seamless)).toEqual({ verdict: "pass" });
    expect(ambientLoopVerdict(await measureAmbientLoop(clip("seam")))).toEqual({
      verdict: "block",
      reason: "loop_seam",
    });
    expect(ambientLoopVerdict(await measureAmbientLoop(clip("frozen")))).toEqual({
      verdict: "block",
      reason: "loop_frozen",
    });
  }, 60_000);

  it("extracts one 1200x2132 JPEG per frame at 30 fps", async () => {
    const frames = await extractLoopFrames(clip("seamless"));
    expect(frames).toHaveLength(60);
    expect(await sharp(frames[0]).metadata()).toMatchObject({
      format: "jpeg",
      width: 1200,
      height: 2132,
    });
  }, 60_000);

  it("rejects bytes that are not a video and leaves no temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-root-"));
    await expect(
      measureAmbientLoop(new Uint8Array([1, 2, 3]), { tmpRoot: root }),
    ).rejects.toThrow();
    await expect(extractLoopFrames(new Uint8Array([1, 2, 3]), { tmpRoot: root })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
