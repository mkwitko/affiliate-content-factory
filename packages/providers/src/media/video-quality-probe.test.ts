import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  blockingCheckIds,
  evaluateRenderQuality,
} from "@money-maker/core/publishing/render-quality";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureRenderedVideo, parseAnalysisLog } from "./video-quality-probe.js";

const run = promisify(execFile);

describe("parseAnalysisLog", () => {
  it("reads detector intervals and the loudness summary", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: 1.5",
      "[blackdetect @ 0x2] black_start:0 black_end:2 black_duration:2",
      "[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: 0",
      "[freezedetect @ 0x3] lavfi.freezedetect.freeze_duration: 2",
      "[freezedetect @ 0x3] lavfi.freezedetect.freeze_end: 2",
      "[silencedetect @ 0x1] silence_end: 4.01705 | silence_duration: 2.51705",
      "[Parsed_ebur128_4 @ 0x4] Summary:",
      "  Integrated loudness:",
      "    I:         -22.2 LUFS",
      "  True peak:",
      "    Peak:      -17.7 dBFS",
    ].join("\n");
    expect(parseAnalysisLog(log, 4_000)).toEqual({
      silences: [{ startMs: 1_500, endMs: 4_000 }],
      blacks: [{ startMs: 0, endMs: 2_000 }],
      freezes: [{ startMs: 0, endMs: 2_000 }],
      integratedLufs: -22.2,
      truePeakDbtp: -17.7,
      decodeErrors: 0,
    });
  });

  it("closes open-ended runs at the duration and counts decoder errors", () => {
    const log = [
      "[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: 3.2",
      "[silencedetect @ 0x1] silence_start: 5",
      "[h264 @ 0x9] error while decoding MB 12 40, bytestream -5",
      "[h264 @ 0x9] concealing 900 DC, 900 AC, 900 MV errors in P frame",
    ].join("\n");
    const parsed = parseAnalysisLog(log, 6_000);
    expect(parsed.freezes).toEqual([{ startMs: 3_200, endMs: 6_000 }]);
    expect(parsed.silences).toEqual([{ startMs: 5_000, endMs: 6_000 }]);
    expect(parsed.decodeErrors).toBe(2);
    expect(parsed.integratedLufs).toBeUndefined();
  });
});

describe("measureRenderedVideo (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "money-maker-render-qa-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks an invalid render: black frames and no audio", async () => {
    const path = join(dir, "black.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1080x1920:r=30:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const stats = await measureRenderedVideo(path);
    expect(stats.hasAudio).toBe(false);
    const report = evaluateRenderQuality(stats, {
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 5_000,
      audioRequired: true,
      plannedStill: [],
      plannedSilence: [],
      plannedDark: [],
    });
    expect(report.verdict).toBe("block");
    expect(blockingCheckIds(report)).toEqual(
      expect.arrayContaining(["audio_stream", "black", "freeze"]),
    );
  }, 60_000);

  it("passes a legitimately static render with a planned still and narration-level audio", async () => {
    const path = join(dir, "static.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xF4EFE6:s=1080x1920:r=30:d=6",
      "-f",
      "lavfi",
      "-i",
      "sine=f=220:d=6",
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ]);
    const stats = await measureRenderedVideo(path);
    expect(stats.freezes.length).toBeGreaterThan(0);
    const report = evaluateRenderQuality(stats, {
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 6_000,
      audioRequired: true,
      plannedStill: [{ startMs: 0, endMs: 6_000 }],
      plannedSilence: [],
      plannedDark: [],
    });
    expect(report.checks.filter((c) => c.verdict !== "pass")).toEqual([]);
    expect(report.verdict).toBe("pass");
  }, 60_000);

  it("reports an unreadable file instead of throwing", async () => {
    const stats = await measureRenderedVideo(join(dir, "missing.mp4"));
    expect(stats.readable).toBe(false);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      measureRenderedVideo(join(dir, "static.mp4"), { signal: controller.signal }),
    ).rejects.toThrow("render_aborted");
  });
});
