import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildReelTimeline } from "@money-maker/core/assets/reel-timeline";
import { createFfmpegReelRenderer, pickMarkLogo } from "./ffmpeg-reel-renderer.js";

const execFileAsync = promisify(execFile);

const ffmpegAvailable = await execFileAsync("ffmpeg", ["-version"])
  .then(() => true)
  .catch(() => false);
const ffprobeAvailable = await execFileAsync("ffprobe", ["-version"])
  .then(() => true)
  .catch(() => false);

const tinySlide = async (
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
) => ({
  bytes: new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .jpeg()
      .toBuffer(),
  ),
  mimeType: "image/jpeg" as const,
  width,
  height,
});

// Skipped in any environment without an ffmpeg/ffprobe binary on PATH; the argument builder
// (ffmpeg-args.test.ts) is unit-tested unconditionally.
describe.skipIf(!ffmpegAvailable || !ffprobeAvailable)("createFfmpegReelRenderer", () => {
  it("renders with a logo mark overlay", async () => {
    const renderer = createFfmpegReelRenderer({
      slideDurationSec: 0.5,
      crossfadeSec: 0.1,
      timeoutMs: 30_000,
    });
    const logo = new Uint8Array(
      await sharp({ create: { width: 64, height: 32, channels: 3, background: "#ffffff" } })
        .png()
        .toBuffer(),
    );
    const output = await renderer.render({
      slides: [await tinySlide(1080, 1920, { r: 20, g: 20, b: 20 })],
      mark: {
        logoLight: logo,
        opacity: 0.7,
        position: "top-left",
        minWidth: 160,
        safeMargin: 0.06,
      },
    });
    expect(output.height).toBe(1920);
    expect(output.bytes.byteLength).toBeGreaterThan(0);
  });

  it("renders a 1080x1920 h264/aac mp4 from two tiny slides", async () => {
    const renderer = createFfmpegReelRenderer({
      slideDurationSec: 0.5,
      crossfadeSec: 0.1,
      timeoutMs: 30_000,
    });
    const output = await renderer.render({
      slides: [
        await tinySlide(1080, 1350, { r: 200, g: 20, b: 20 }),
        await tinySlide(1080, 1920, { r: 20, g: 20, b: 200 }),
      ],
    });

    expect(output.mimeType).toBe("video/mp4");
    expect(output.width).toBe(1080);
    expect(output.height).toBe(1920);
    expect(output.bytes.byteLength).toBeGreaterThan(0);

    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reel-probe-"));
    const path = join(dir, "probe.mp4");
    try {
      await writeFile(path, output.bytes);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name",
        "-of",
        "json",
        path,
      ]);
      const probe = JSON.parse(stdout) as {
        streams: readonly {
          width: number;
          height: number;
          codec_name: string;
        }[];
      };
      expect(probe.streams[0]).toMatchObject({
        width: 1080,
        height: 1920,
        codec_name: "h264",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("mixes the chosen track, looped and trimmed to the video length", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reel-music-"));
    try {
      // A 1s tone shorter than the video proves the track loops to fill it.
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        join(dir, "tone.m4a"),
      ]);
      const renderer = createFfmpegReelRenderer({
        slideDurationSec: 1.5,
        crossfadeSec: 0.3,
        timeoutMs: 30_000,
      });
      const output = await renderer.render({
        slides: [
          await tinySlide(1080, 1350, { r: 200, g: 20, b: 20 }),
          await tinySlide(1080, 1350, { r: 20, g: 200, b: 20 }),
        ],
        musicFile: join(dir, "tone.m4a"),
      });
      const path = join(dir, "probe.mp4");
      await writeFile(path, output.bytes);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,duration",
        "-of",
        "json",
        path,
      ]);
      const probe = JSON.parse(stdout) as {
        streams: readonly { codec_name: string; duration: string }[];
      };
      expect(probe.streams[0]?.codec_name).toBe("aac");
      // 2 * 1.5 - 0.3 = 2.7s
      expect(Number(probe.streams[0]?.duration)).toBeCloseTo(2.7, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("renders a voiced reel from the timeline and voice clips, cleaning up its temp dir", async () => {
    const { mkdtemp, readFile, readdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reel-clip-"));
    // A private temp root: other renders on the machine (a worker, a parallel suite) cannot
    // leave directories in it, so an empty root after render proves this render cleaned up.
    const renderRoot = await mkdtemp(join(tmpdir(), "reel-root-"));
    try {
      const makeClip = async (name: string) => {
        const path = join(dir, name);
        await execFileAsync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-ar",
          "24000",
          path,
        ]);
        return new Uint8Array(await readFile(path));
      };
      const clip0 = await makeClip("clip0.wav");
      const clip1 = await makeClip("clip1.wav");

      const timeline = buildReelTimeline({
        slideCount: 2,
        clips: [
          { durationMs: 1000, words: [{ text: "oi", startMs: 0, endMs: 500 }] },
          { durationMs: 1000, words: [] },
        ],
      });

      const renderer = createFfmpegReelRenderer({ timeoutMs: 30_000, tmpRoot: renderRoot });
      const output = await renderer.render({
        slides: [
          await tinySlide(1080, 1350, { r: 200, g: 20, b: 20 }),
          await tinySlide(1080, 1920, { r: 20, g: 20, b: 200 }),
        ],
        timeline,
        voiceClips: [clip0, clip1],
      });

      expect(Math.abs(output.durationMs / 1000 - timeline.totalSec)).toBeLessThan(0.3);

      const probePath = join(dir, "probe.mp4");
      await writeFile(probePath, output.bytes);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        probePath,
      ]);
      const probe = JSON.parse(stdout) as { streams: readonly { codec_type: string }[] };
      expect(probe.streams.filter((s) => s.codec_type === "video")).toHaveLength(1);
      expect(probe.streams.filter((s) => s.codec_type === "audio")).toHaveLength(1);

      // The self-reported durationMs above is derived from the requested totalDurationSec, not
      // the actual file, so it cannot catch a filter graph that silently truncates the render
      // (e.g. the voice track ending before the last slide's Ken Burns/crossfade tail). Probe
      // the real file's duration too.
      const { stdout: durationStdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        probePath,
      ]);
      const durationProbe = JSON.parse(durationStdout) as { format: { duration: string } };
      expect(Math.abs(Number(durationProbe.format.duration) - timeline.totalSec)).toBeLessThan(0.3);

      expect(await readdir(renderRoot)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(renderRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("renders the full reel length when voice is mixed under background music", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reel-voice-music-"));
    try {
      const musicPath = join(dir, "music.m4a");
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=30",
        musicPath,
      ]);

      const makeClip = async (name: string) => {
        const path = join(dir, name);
        await execFileAsync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-ar",
          "24000",
          path,
        ]);
        return new Uint8Array(await readFile(path));
      };
      const clip0 = await makeClip("clip0.wav");
      const clip1 = await makeClip("clip1.wav");

      const timeline = buildReelTimeline({
        slideCount: 2,
        clips: [
          { durationMs: 1000, words: [{ text: "oi", startMs: 0, endMs: 500 }] },
          { durationMs: 1000, words: [] },
        ],
      });

      const renderer = createFfmpegReelRenderer({ timeoutMs: 30_000 });
      const output = await renderer.render({
        slides: [
          await tinySlide(1080, 1350, { r: 200, g: 20, b: 20 }),
          await tinySlide(1080, 1920, { r: 20, g: 20, b: 200 }),
        ],
        musicFile: musicPath,
        timeline,
        voiceClips: [clip0, clip1],
      });

      const probePath = join(dir, "probe.mp4");
      await writeFile(probePath, output.bytes);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        probePath,
      ]);
      const probe = JSON.parse(stdout) as { format: { duration: string } };
      // Regression guard: sidechaincompress ends at its shorter sidechain-key input, and
      // -shortest previously truncated the whole render to the voice mix's length instead of
      // the full timeline (see b5-review.md). The voice track must be padded so the render
      // runs the full reel length.
      expect(Math.abs(Number(probe.format.duration) - timeline.totalSec)).toBeLessThan(0.3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a voice clip count that does not match the slide count", async () => {
    const renderer = createFfmpegReelRenderer();
    const timeline = buildReelTimeline({ slideCount: 2 });
    await expect(
      renderer.render({
        slides: [
          await tinySlide(1080, 1350, { r: 1, g: 1, b: 1 }),
          await tinySlide(1080, 1350, { r: 2, g: 2, b: 2 }),
        ],
        timeline,
        voiceClips: [new Uint8Array([0])],
      }),
    ).rejects.toThrow("reel_voice_clip_count_invalid");
  });

  it("grades a voiced Ken Burns reel of textured slides without blocking it", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reel-qa-"));
    try {
      const clipPath = join(dir, "clip.wav");
      // Narration stand-in: speech-like bursts with short pauses, 6 s per slide.
      await execFileAsync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=180:duration=6,volume='if(lt(mod(t,1.2),0.9),1,0)':eval=frame",
        "-ar",
        "24000",
        clipPath,
      ]);
      const clip = new Uint8Array(await readFile(clipPath));
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
      const output = await createFfmpegReelRenderer({ timeoutMs: 120_000 }).render({
        slides: [await textured(0), await textured(1), await textured(2)],
        timeline,
        voiceClips: [clip, clip, clip],
        motions: ["ken_burns_in", "ken_burns_out", "static"],
      });
      const report = output.quality;
      expect(report).toBeDefined();
      expect(report?.verdict).not.toBe("block");
      expect(report?.checks.find((c) => c.id === "freeze")?.verdict).toBe("pass");
      expect(report?.checks.find((c) => c.id === "silence")?.verdict).toBe("pass");
      expect(report?.checks.find((c) => c.id === "loudness")?.verdict).toBe("pass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("kills ffmpeg and removes its temp dir when the signal aborts mid-render", async () => {
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "reel-abort-root-"));
    try {
      const renderer = createFfmpegReelRenderer({
        slideDurationSec: 40,
        maxDurationSec: 900,
        timeoutMs: 120_000,
        tmpRoot: root,
      });
      const controller = new AbortController();
      const rendering = renderer.render(
        {
          slides: [
            await tinySlide(1080, 1350, { r: 200, g: 20, b: 20 }),
            await tinySlide(1080, 1350, { r: 20, g: 200, b: 20 }),
          ],
        },
        { signal: controller.signal },
      );
      // Wait until ffmpeg is actually running with this render's temp dir in its arguments.
      const running = async () =>
        (await execFileAsync("ps", ["-eo", "args"])).stdout
          .split("\n")
          .filter((line) => line.includes(root) && line.startsWith("ffmpeg"));
      for (let i = 0; i < 100 && (await running()).length === 0; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await running()).length).toBe(1);
      controller.abort(new Error("render_timeout"));
      await expect(rendering).rejects.toThrow("render_aborted");
      expect(await running()).toEqual([]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("pickMarkLogo", () => {
  const light = new Uint8Array([1]);
  const dark = new Uint8Array([2]);
  const frame = (value: number) =>
    sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: value, g: value, b: value } },
    })
      .png()
      .toBuffer();

  it("uses the dark logo on bright footage and the light one otherwise", async () => {
    expect(await pickMarkLogo({ logoLight: light, logoDark: dark }, await frame(240))).toBe(dark);
    expect(await pickMarkLogo({ logoLight: light, logoDark: dark }, await frame(20))).toBe(light);
  });

  it("uses the only variant available, and falls back to light on an unreadable frame", async () => {
    expect(await pickMarkLogo({ logoDark: dark }, await frame(20))).toBe(dark);
    expect(await pickMarkLogo({ logoLight: light, logoDark: dark }, new Uint8Array([0]))).toBe(
      light,
    );
  });
});

const makeClip = async (seconds: number, size = "320x568"): Promise<Uint8Array> => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "clip-src-"));
  try {
    const path = join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=24:duration=${seconds}`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      path,
    ]);
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe.skipIf(!ffmpegAvailable || !ffprobeAvailable)("video slides (real ffmpeg)", () => {
  const videoSlide = (bytes: Uint8Array) => ({
    bytes,
    mimeType: "video/mp4" as const,
    width: 320,
    height: 568,
  });
  // Default crossfade (0.8 s) matches buildReelTimeline, as in render_long_form.
  const renderer = createFfmpegReelRenderer({ timeoutMs: 60_000 });
  const timeline = buildReelTimeline({
    slideCount: 2,
    clips: [
      { durationMs: 2500, words: [{ text: "one", startMs: 0, endMs: 2500 }] },
      { durationMs: 1200, words: [{ text: "two", startMs: 0, endMs: 1200 }] },
    ],
    maxTotalSec: 60,
  });

  it("loops a clip shorter than its scene and trims one that is longer", async () => {
    // Scene 1 needs about 3 s from a 1 s clip (loop); scene 2 about 1.7 s from a 4 s clip (trim).
    const output = await renderer.render({
      slides: [videoSlide(await makeClip(1)), videoSlide(await makeClip(4))],
      timeline,
    });
    const expectedMs = timeline.totalSec * 1000;
    expect(output.width).toBe(1080);
    expect(output.height).toBe(1920);
    expect(Math.abs(output.durationMs - expectedMs)).toBeLessThan(50);
    expect(output.quality?.verdict).not.toBe("block");
    // Probe the real file: the muxed length follows the plan, not the source clip lengths.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "clip-probe-"));
    try {
      await writeFile(join(dir, "o.mp4"), output.bytes);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        join(dir, "o.mp4"),
      ]);
      expect(Math.abs(Number(stdout) * 1000 - expectedMs)).toBeLessThan(300);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("mixes clips and images in one render", async () => {
    const output = await renderer.render({
      slides: [videoSlide(await makeClip(1)), await tinySlide(1080, 1920, { r: 10, g: 90, b: 10 })],
      timeline,
    });
    expect(output.height).toBe(1920);
    expect(output.bytes.byteLength).toBeGreaterThan(0);
  }, 60_000);
});
