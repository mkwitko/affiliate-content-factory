import { describe, expect, it } from "vitest";
import { buildOwnedClipFfmpegArgs, buildFocusSendcmd } from "./owned-clip-ffmpeg-args.js";

describe("buildOwnedClipFfmpegArgs", () => {
  it("cuts and re-encodes a bounded segment without shell interpolation", () => {
    expect(
      buildOwnedClipFfmpegArgs({
        inputPath: "/tmp/source.mp4",
        outputPath: "/tmp/clip.mp4",
        startMs: 1_234,
        endMs: 9_876,
      }),
    ).toEqual([
      "-y",
      "-threads",
      "2",
      "-i",
      "/tmp/source.mp4",
      "-ss",
      "1.234",
      "-t",
      "8.642",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "/tmp/clip.mp4",
    ]);
  });

  it("rejects invalid and over-three-minute intervals", () => {
    expect(() =>
      buildOwnedClipFfmpegArgs({ inputPath: "source", outputPath: "clip", startMs: -1, endMs: 1 }),
    ).toThrow("clip_boundaries_invalid");
    expect(() =>
      buildOwnedClipFfmpegArgs({
        inputPath: "source",
        outputPath: "clip",
        startMs: 0,
        endMs: 180_001,
      }),
    ).toThrow("clip_boundaries_invalid");
  });

  it("fits vertical output inside 1080x1920 without cropping source claims or visuals", () => {
    const args = buildOwnedClipFfmpegArgs({
      inputPath: "source",
      outputPath: "clip",
      startMs: 0,
      endMs: 10_000,
      layout: "vertical",
    });
    expect(args).toContain(
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black",
    );
  });

  it("burns supplied captions only into vertical output and escapes the subtitle path", () => {
    const args = buildOwnedClipFfmpegArgs({
      inputPath: "source",
      outputPath: "clip",
      startMs: 0,
      endMs: 10_000,
      layout: "vertical",
      captionsPath: "/tmp/clip:caps.ass",
    });
    const filter = args[args.indexOf("-vf") + 1];
    expect(filter).toContain(",subtitles=filename=/tmp/clip\\:caps.ass");
    expect(
      buildOwnedClipFfmpegArgs({
        inputPath: "source",
        outputPath: "clip",
        startMs: 0,
        endMs: 10_000,
        layout: "source",
        captionsPath: "/tmp/clip.ass",
      }),
    ).not.toContain("-vf");
  });

  it("fills a landscape frame with a blurred copy instead of black bars and burns captions after the overlay", () => {
    const args = buildOwnedClipFfmpegArgs({
      inputPath: "source",
      outputPath: "clip",
      startMs: 0,
      endMs: 10_000,
      layout: "vertical_blur",
      captionsPath: "/tmp/c.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toBe(
      "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:5[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,subtitles=filename=/tmp/c.ass[v]",
    );
    expect(args).not.toContain("0:v:0");
    expect(args[args.indexOf("-map") + 1]).toBe("[v]");
    expect(args.filter((a) => a === "-map")).toHaveLength(2);
  });

  it("crops a 9:16 window driven by a sendcmd file for vertical_focus", () => {
    const args = buildOwnedClipFfmpegArgs({
      inputPath: "source",
      outputPath: "clip",
      startMs: 0,
      endMs: 10_000,
      layout: "vertical_focus",
      captionsPath: "/tmp/c.ass",
      focus: { cropWidth: 608, initialX: 176, commandsPath: "/tmp/f:cmd.txt" },
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:v]sendcmd=f=/tmp/f\\:cmd.txt,crop@c=w=608:h=ih:x=176:y=0,scale=1080:1920,subtitles=filename=/tmp/c.ass[v]",
    );
  });

  it("falls back to the blurred fill when vertical_focus has no focus track", () => {
    const args = buildOwnedClipFfmpegArgs({
      inputPath: "source",
      outputPath: "clip",
      startMs: 0,
      endMs: 10_000,
      layout: "vertical_focus",
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("boxblur=30:5");
  });
});

describe("buildFocusSendcmd", () => {
  const points = [
    { tMs: 0, x: 100 },
    { tMs: 4000, x: 900 },
    { tMs: 9000, x: 300 },
  ];
  it("seeds the window at the clip start and keeps source-time cuts inside the clip", () => {
    expect(buildFocusSendcmd(points, 2000, 9000)).toEqual({
      initialX: 100,
      text: "4.000 crop@c x 900;\n",
    });
    expect(buildFocusSendcmd(points, 5000, 12_000)).toEqual({
      initialX: 900,
      text: "9.000 crop@c x 300;\n",
    });
  });
});
