import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, escapeFilterPath } from "./ffmpeg-args.js";

describe("buildFfmpegArgs", () => {
  it("loops each slide as an input and holds it for the slide duration", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
    });
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-t", "4.000", "-i", "/tmp/a.jpg"]));
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-t", "4.000", "-i", "/tmp/b.jpg"]));
  });

  it("adds a silent stereo track and encodes h264/yuv420p/aac with faststart", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/out.mp4",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(["-pix_fmt", "yuv420p"]));
    // ffmpeg 7.1+ keeps JPEG full range (yuvj420p) unless the output range is set.
    expect(args).toEqual(expect.arrayContaining(["-color_range", "tv"]));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264"]));
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "192k"]));
    expect(args).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
    expect(args.at(-1)).toBe("/tmp/out.mp4");
  });

  it("maps a single slide directly, with no crossfade filter", () => {
    const { args, totalDurationSec } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/out.mp4",
    });
    expect(args).toEqual(expect.arrayContaining(["-map", "[v0]", "-map", "1:a"]));
    expect(args.join(" ")).not.toContain("xfade");
    expect(totalDurationSec).toBeCloseTo(4, 3);
  });

  it("crossfades consecutive slides and reduces total duration by the overlap", () => {
    const { args, totalDurationSec } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"],
      slideDurationSec: 2.5,
      crossfadeSec: 0.4,
      outputPath: "/tmp/out.mp4",
    });
    const filterComplexIndex = args.indexOf("-filter_complex");
    const filterComplex = args[filterComplexIndex + 1] ?? "";
    expect(filterComplex).toContain("xfade=transition=fade:duration=0.400:offset=2.100");
    // Transitions rotate per slide so a long reel does not repeat the same fade.
    expect(filterComplex).toContain("xfade=transition=slideleft:duration=0.400:offset=4.200");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vout]", "-map", "3:a"]));
    // 3 * 2.5 - 2 * 0.4 = 6.7s
    expect(totalDurationSec).toBeCloseTo(6.7, 3);
  });

  it("keeps the whole reel within the 60s cap for the maximum carousel slide count", () => {
    const { totalDurationSec } = buildFfmpegArgs({
      slidePaths: Array.from({ length: 10 }, (_, index) => `/tmp/${index}.jpg`),
      outputPath: "/tmp/out.mp4",
    });
    expect(totalDurationSec).toBeLessThanOrEqual(60);
  });

  it("loops the music under the whole reel with a fade in and out", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
      musicPath: "/music/track.mp3",
    });
    expect(args).toEqual(expect.arrayContaining(["-stream_loop", "-1", "-i", "/music/track.mp3"]));
    expect(args.join(" ")).not.toContain("anullsrc");
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    // 2 * 4 - 0.8 = 7.2s; fade out starts 1.5s before the end
    expect(filterComplex).toContain(
      "[2:a]volume=0.35,afade=t=in:d=1,afade=t=out:st=5.700:d=1.500[aout]",
    );
    expect(args).toEqual(expect.arrayContaining(["-map", "[vout]", "-map", "[aout]"]));
    expect(filterComplex).not.toContain("loudnorm");
  });

  it("applies storyboard motion and landscape output dimensions", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/out.mp4",
      width: 1920,
      height: 1080,
      motions: ["static"],
    });
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("scale=3840:2160");
    expect(filterComplex).toContain("zoompan=z='1':x='iw/2-(iw/zoom/2)'");
    expect(filterComplex).toContain(":s=1920x1080:");
  });

  it("rejects storyboard motions that do not align with the scene count", () => {
    expect(() =>
      buildFfmpegArgs({ slidePaths: ["/tmp/a.jpg"], outputPath: "/tmp/out.mp4", motions: [] }),
    ).toThrow("reel_motions_invalid");
  });

  it("rejects an empty slide list", () => {
    expect(() => buildFfmpegArgs({ slidePaths: [], outputPath: "/tmp/out.mp4" })).toThrow(
      "reel_slide_count_invalid",
    );
  });

  it("rejects a crossfade at least as long as the slide duration", () => {
    expect(() =>
      buildFfmpegArgs({
        slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
        slideDurationSec: 1,
        crossfadeSec: 1,
        outputPath: "/tmp/out.mp4",
      }),
    ).toThrow("reel_crossfade_too_long");
  });

  it("accepts per-slide durations for per-slide -t and total timing", () => {
    const { args, totalDurationSec } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
      slideDurationsSec: [3, 5],
    });
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-t", "3.000", "-i", "/tmp/a.jpg"]));
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-t", "5.000", "-i", "/tmp/b.jpg"]));
    expect(totalDurationSec).toBeCloseTo(7.2, 3);
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("offset=2.200");
  });

  it("rejects per-slide durations whose length does not match the slide count", () => {
    expect(() =>
      buildFfmpegArgs({
        slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
        outputPath: "/tmp/out.mp4",
        slideDurationsSec: [3],
      }),
    ).toThrow("reel_slide_durations_invalid");
  });

  it("alternates Ken Burns zoom direction per slide and centers with x/y", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
    });
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    const filters = filterComplex.split(";");
    expect(filters[0]).toContain("min(1+0.0015*on,1.2)");
    expect(filters[1]).toContain("max(1.2-0.0015*on,1.0)");
    expect(filters[0]).toContain("x='iw/2-(iw/zoom/2)'");
    expect(filters[1]).toContain("x='iw/2-(iw/zoom/2)'");
    expect(filters[0]).toContain("y='ih/2-(ih/zoom/2)'");
  });

  it("upscales each slide before zoompan so the slow zoom does not judder", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/out.mp4",
    });
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("[0:v]scale=2160:3840:flags=lanczos,fps=30,zoompan=");
    expect(filterComplex).toContain(":s=1080x1920:");
  });

  it("burns captions after the video chain and maps the captioned output", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
      captionsPath: "/tmp/reel-x/captions.ass",
    });
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("subtitles=filename=/tmp/reel-x/captions.ass");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vcap]"]));
  });

  it("burns captions for a single slide off the v0 label", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/out.mp4",
      captionsPath: "/tmp/reel-x/captions.ass",
    });
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("[v0]subtitles=filename=/tmp/reel-x/captions.ass[vcap]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vcap]"]));
  });

  it("escapes filter path colons, quotes, and backslashes", () => {
    expect(escapeFilterPath("/a:b/c'd\\e")).toBe("/a\\:b/c\\'d\\\\e");
  });

  it("mixes voice clips with adelay, ducks music under the voice, and maps the mixed track", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
      musicPath: "/music/track.mp3",
      voice: { clipPaths: ["/tmp/v0.wav", "/tmp/v1.wav"], startSec: [0, 3.5] },
    });
    expect(args).toEqual(expect.arrayContaining(["-stream_loop", "-1", "-i", "/music/track.mp3"]));
    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/v0.wav"]));
    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/v1.wav"]));
    const inputsOrder = args.join(" ");
    expect(inputsOrder.indexOf("/music/track.mp3")).toBeLessThan(
      inputsOrder.indexOf("/tmp/v0.wav"),
    );
    expect(inputsOrder.indexOf("/tmp/v0.wav")).toBeLessThan(inputsOrder.indexOf("/tmp/v1.wav"));
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).toContain("adelay=0|0");
    expect(filterComplex).toContain("adelay=3500|3500");
    expect(filterComplex).toContain("amix=inputs=2:normalize=0:duration=longest[voice]");
    expect(filterComplex).toContain("[voice]apad,asplit=2[vkey][vmix]");
    expect(filterComplex).toContain(
      "sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400",
    );
    expect(filterComplex).toContain("amix=inputs=2:normalize=0:duration=first");
    expect(filterComplex).toContain("[amaster]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[aout]"]));
  });

  it("mixes voice without music, skipping the silent track and the ducking chain", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/out.mp4",
      voice: { clipPaths: ["/tmp/v0.wav", "/tmp/v1.wav"], startSec: [0, 3.5] },
    });
    expect(args.join(" ")).not.toContain("anullsrc");
    const filterComplex = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filterComplex).not.toContain("sidechaincompress");
    expect(filterComplex).not.toContain("asplit");
    expect(filterComplex).toContain("[voice]apad,afade=t=out");
    expect(filterComplex).toContain("[amaster]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[aout]"]));
  });

  it("plans still frames where zoompan holds: static slides and capped Ken Burns zooms", () => {
    const { plannedStill } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"],
      motions: ["static", "ken_burns_in", "pan_left"],
      slideDurationsSec: [3, 6, 5],
      outputPath: "/tmp/out.mp4",
    });
    // Slide b starts at 3 - 0.8 = 2.2 s; its zoom reaches 1.2 after 133.3 frames (4.444 s).
    // A pan at 1080 px wide drifts for 540 frames (18 s), longer than slide c.
    expect(plannedStill).toEqual([
      { startMs: 0, endMs: 3_000 },
      { startMs: 6_644, endMs: 8_200 },
    ]);
  });
});

describe("buildFfmpegArgs mark overlay", () => {
  const mark = {
    path: "/tmp/mark.png",
    opacity: 0.6,
    position: "top-right" as const,
    width: 160,
    safeMargin: 0.06,
  };
  const filter = (args: readonly string[]) => args[args.indexOf("-filter_complex") + 1] as string;

  it("adds no overlay without a mark", () => {
    const { args } = buildFfmpegArgs({ slidePaths: ["/tmp/a.jpg"], outputPath: "/tmp/o.mp4" });
    expect(filter(args)).not.toContain("overlay=");
    expect(args).not.toContain("/tmp/mark.png");
  });

  it("overlays the logo after captions, with the mark as the last input", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/o.mp4",
      captionsPath: "/tmp/c.ass",
      mark,
    });
    const graph = filter(args);
    // input 0 slide, 1 silent audio, 2 mark
    expect(graph).toContain("[2:v]format=rgba,scale=160:-1,colorchannelmixer=aa=0.60[mk]");
    expect(graph).toContain("[vcap][mk]overlay=main_w-overlay_w-65:250[vmark]");
    expect(args[args.indexOf("/tmp/mark.png") - 1]).toBe("-i");
    expect(args[args.indexOf("-map") + 1]).toBe("[vmark]");
  });

  it("indexes the mark after music and voice inputs", () => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
      outputPath: "/tmp/o.mp4",
      musicPath: "/tmp/m.mp3",
      voice: { clipPaths: ["/tmp/v0.wav", "/tmp/v1.wav"], startSec: [0, 4] },
      mark: { ...mark, position: "bottom-left" },
    });
    // 2 slides + music + 2 voice clips -> mark is input 5
    expect(filter(args)).toContain("[5:v]format=rgba");
    expect(filter(args)).toContain("overlay=65:main_h-overlay_h-422[vmark]");
  });
});

describe("buildFfmpegArgs music gain", () => {
  const graph = (musicGain?: number, voice = false) => {
    const { args } = buildFfmpegArgs({
      slidePaths: ["/tmp/a.jpg"],
      outputPath: "/tmp/o.mp4",
      musicPath: "/tmp/m.mp3",
      ...(voice ? { voice: { clipPaths: ["/tmp/v.wav"], startSec: [0] } } : {}),
      ...(musicGain ? { musicGain } : {}),
    });
    return args[args.indexOf("-filter_complex") + 1] as string;
  };
  it("keeps today's levels by default and scales them with the gain", () => {
    expect(graph()).toContain("volume=0.35,");
    expect(graph(undefined, true)).toContain("volume=0.5[m0]");
    expect(graph(0.6)).toContain("volume=0.21,");
    expect(graph(1.5, true)).toContain("volume=0.75[m0]");
  });
});

describe("buildFfmpegArgs video slides", () => {
  const build = (videoSlides: readonly boolean[]) =>
    buildFfmpegArgs({
      slidePaths: ["/tmp/a.mp4", "/tmp/b.jpg"],
      videoSlides,
      motions: ["static", "static"],
      outputPath: "/tmp/out.mp4",
      slideDurationsSec: [3, 2],
      crossfadeSec: 0.5,
    });

  it("loops the clip input endlessly and cuts it at the scene duration", () => {
    const { args } = build([true, false]);
    expect(args).toEqual(
      expect.arrayContaining(["-stream_loop", "-1", "-t", "3.000", "-i", "/tmp/a.mp4"]),
    );
    // The image slide keeps its still-loop input.
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-t", "2.000", "-i", "/tmp/b.jpg"]));
    expect(args.join(" ")).not.toMatch(/-loop 1 -t 3.000 -i \/tmp\/a.mp4/);
  });
  it("fills the frame without the Ken Burns zoom for a clip, and keeps it for an image", () => {
    const filter = String(
      build([true, false]).args[build([true, false]).args.indexOf("-filter_complex") + 1],
    );
    const [clip, image] = filter.split(";");
    expect(clip).toContain("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
    expect(clip).not.toContain("zoompan");
    expect(image).toContain("zoompan");
  });
  it("plans no still window for a clip", () => {
    const withClip = build([true, false]).plannedStill;
    const images = build([false, false]).plannedStill;
    expect(images.length).toBeGreaterThan(withClip.length);
    expect(withClip.every((range) => range.startMs >= 2500)).toBe(true);
  });
  it("keeps every other part of the graph identical to an all-image build", () => {
    const tail = (videoSlides: readonly boolean[]) => {
      const args = build(videoSlides).args;
      const filter = String(args[args.indexOf("-filter_complex") + 1]);
      return filter.split(";").slice(2).join(";");
    };
    expect(tail([true, false])).toBe(tail([false, false]));
  });
  it("rejects a flag list that does not match the slides", () => {
    expect(() => build([true])).toThrow("reel_video_slides_invalid");
  });
});

describe("buildFfmpegArgs edit style v2", () => {
  const filter = (args: readonly string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";
  const slides = ["a.jpg", "b.jpg", "c.jpg"];

  it("eases motion, cuts long slides into a wide and a tighter shot, and never plans a still", () => {
    const result = buildFfmpegArgs({
      slidePaths: slides,
      outputPath: "out.mp4",
      editStyle: "v2",
      slideDurationsSec: [3, 2, 3],
    });
    const graph = filter(result.args);
    expect(graph).toContain("cos(PI*");
    // 3 s at 30 fps: the tighter framing cuts in at frame round(90 * 0.55) = 50.
    expect(graph).toContain("if(lt(on,50),");
    expect(graph).toContain("1.08+0.02*");
    // The 2 s slide stays one shot (below V2_SPLIT_MIN_SEC).
    expect(graph.split("if(lt(on,").length - 1).toBe(2);
    expect(graph).not.toMatch(/slideleft|circleopen|slideup|smoothleft/);
    expect(graph).toContain("xfade=transition=fade:duration=0.120");
    expect(result.plannedStill).toEqual([]);
    expect(result.totalDurationSec).toBeCloseTo(8 - 2 * 0.12, 3);
  });

  it("keeps v1 as the default edit", () => {
    const graph = filter(buildFfmpegArgs({ slidePaths: slides, outputPath: "o.mp4" }).args);
    expect(graph).toContain("min(1+0.0015*on,1.2)");
    expect(graph).toContain("xfade=transition=fade:duration=0.800");
    expect(graph).toContain("xfade=transition=slideleft");
  });

  it("follows the voice timeline's overlap when one is given", () => {
    const graph = filter(
      buildFfmpegArgs({
        slidePaths: slides,
        outputPath: "o.mp4",
        editStyle: "v2",
        crossfadeSec: 0.8,
      }).args,
    );
    expect(graph).toContain("duration=0.800");
  });
});
