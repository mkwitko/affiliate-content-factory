import type { RenderStats } from "@money-maker/core/publishing/render-quality";
import { describe, expect, it } from "vitest";
import { evaluateClipStats } from "./scene-clip-check.js";

const expected = { width: 768, height: 1152, seconds: 5 };
const stats = (over: Partial<RenderStats> = {}): RenderStats => ({
  readable: true,
  decodeErrors: 0,
  video: { codec: "h264", pixelFormat: "yuv420p", width: 768, height: 1152, fps: 24 },
  hasAudio: false,
  durationMs: 5000,
  silences: [],
  blacks: [],
  freezes: [],
  ...over,
});

describe("evaluateClipStats", () => {
  it("accepts a clip with the requested size and a duration within 1 s", () => {
    expect(evaluateClipStats(stats(), expected)).toEqual({ ok: true });
    expect(evaluateClipStats(stats({ durationMs: 5900 }), expected)).toEqual({ ok: true });
    expect(evaluateClipStats(stats({ durationMs: 4100 }), expected)).toEqual({ ok: true });
  });
  it("rejects an unreadable file or one without video", () => {
    expect(evaluateClipStats(stats({ readable: false }), expected)).toEqual({
      ok: false,
      reason: "unreadable",
    });
    const { video: _video, ...noVideo } = stats();
    expect(evaluateClipStats(noVideo as RenderStats, expected)).toEqual({
      ok: false,
      reason: "no_video",
    });
  });
  it("rejects a rotated 1280x720 container and any other size", () => {
    expect(
      evaluateClipStats(
        stats({
          video: { codec: "h264", pixelFormat: "yuv420p", width: 1280, height: 720, fps: 24 },
        }),
        expected,
      ),
    ).toEqual({ ok: false, reason: "dimensions_mismatch:1280x720" });
  });
  it("accepts the provider snapping 768x1152 to its 832x1088 portrait tier (A0, 2026-10-01)", () => {
    expect(
      evaluateClipStats(
        stats({
          video: { codec: "h264", pixelFormat: "yuv420p", width: 832, height: 1088, fps: 24 },
        }),
        expected,
      ),
    ).toEqual({ ok: true });
  });
  it("rejects a clip much smaller than requested", () => {
    expect(
      evaluateClipStats(
        stats({
          video: { codec: "h264", pixelFormat: "yuv420p", width: 512, height: 768, fps: 24 },
        }),
        expected,
      ),
    ).toEqual({ ok: false, reason: "dimensions_mismatch:512x768" });
  });
  it("rejects a duration more than 1 s off", () => {
    expect(evaluateClipStats(stats({ durationMs: 6100 }), expected)).toEqual({
      ok: false,
      reason: "duration_mismatch",
    });
    expect(evaluateClipStats(stats({ durationMs: 3900 }), expected)).toEqual({
      ok: false,
      reason: "duration_mismatch",
    });
  });
  it("rejects a clip that is mostly black or frozen, but not a short fade", () => {
    expect(evaluateClipStats(stats({ blacks: [{ startMs: 0, endMs: 4800 }] }), expected)).toEqual({
      ok: false,
      reason: "black_clip",
    });
    expect(
      evaluateClipStats(stats({ freezes: [{ startMs: 500, endMs: 5000 }] }), expected),
    ).toEqual({ ok: false, reason: "frozen_clip" });
    expect(
      evaluateClipStats(
        stats({ blacks: [{ startMs: 0, endMs: 600 }], freezes: [{ startMs: 4000, endMs: 5000 }] }),
        expected,
      ),
    ).toEqual({ ok: true });
  });
  it("rejects decode errors", () => {
    expect(evaluateClipStats(stats({ decodeErrors: 2 }), expected)).toEqual({
      ok: false,
      reason: "decode_errors",
    });
  });
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkSceneClip } from "./scene-clip-check.js";

const execFileAsync = promisify(execFile);
const binaries = await Promise.all(
  ["ffmpeg", "ffprobe"].map((name) =>
    execFileAsync(name, ["-version"]).then(
      () => true,
      () => false,
    ),
  ),
);
describe.skipIf(!binaries.every(Boolean))("checkSceneClip (real ffprobe)", () => {
  const make = async (size: string, seconds: number) => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "clip-check-"));
    try {
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${size}:rate=24:duration=${seconds}`,
        "-pix_fmt",
        "yuv420p",
        join(dir, "c.mp4"),
      ]);
      return new Uint8Array(await readFile(join(dir, "c.mp4")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  it("accepts a clip of the requested size and length and rejects the wrong size or length", async () => {
    const clip = await make("320x568", 2);
    expect(await checkSceneClip(clip, { width: 320, height: 568, seconds: 2 })).toEqual({
      ok: true,
    });
    expect(await checkSceneClip(clip, { width: 768, height: 1152, seconds: 2 })).toMatchObject({
      ok: false,
    });
    expect(await checkSceneClip(clip, { width: 320, height: 568, seconds: 5 })).toEqual({
      ok: false,
      reason: "duration_mismatch",
    });
    expect(
      await checkSceneClip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        width: 320,
        height: 568,
        seconds: 2,
      }),
    ).toEqual({ ok: false, reason: "unreadable" });
  }, 30_000);
});
