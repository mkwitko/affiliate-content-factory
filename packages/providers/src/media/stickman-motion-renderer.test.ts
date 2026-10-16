import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReelRenderOutput } from "@money-maker/core/assets/reel-renderer";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import type { ChunkCache } from "@money-maker/core/explainer/motion/chunks";
import { composeMotionFrame } from "@money-maker/core/explainer/motion/frame";
import { type MotionPlan, planMotion } from "@money-maker/core/explainer/motion/plan";
import type { ActorAction, SceneSpec } from "@money-maker/core/explainer/scene-spec";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractLoopFrames } from "./ambient-loop.js";
import { buildMotionAudioArgs, createStickmanMotionRenderer } from "./stickman-motion-renderer.js";

const run = promisify(execFile);
const alex = {
  key: "alex",
  name: "Alex",
  role: "main" as const,
  rigId: "stick-v1" as const,
  rigVersion: 1 as const,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const scene = (index: number, over: Partial<SceneSpec>): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: 1,
  purpose: "explanation",
  background: "store",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "center" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const timing = (startMs: number, text: string, voiceMs: number) => {
  const tokens = text.split(" ");
  const step = voiceMs / tokens.length;
  const words = tokens.map((word, i) => ({
    text: word,
    startMs: Math.round(startMs + 200 + i * step),
    endMs: Math.round(startMs + 200 + (i + 1) * step - 40),
  }));
  return {
    startMs,
    endMs: startMs + 200 + voiceMs + 300,
    voiceStartMs: startMs + 200,
    voiceEndMs: startMs + 200 + voiceMs,
    words,
    text,
  };
};

describe("buildMotionAudioArgs", () => {
  it("places each voice clip and cue with adelay and normalises the mix", () => {
    const args = buildMotionAudioArgs({
      videoPath: "/t/video.mp4",
      voicePaths: ["/t/v0.wav", "/t/v1.wav"],
      voiceStartMs: [200, 2_000],
      sfxPaths: { pop: "/t/pop.wav", ding: "/t/ding.wav" },
      cues: [
        { id: "pop", atMs: 100 },
        { id: "pop", atMs: 900 },
        { id: "ding", atMs: 2_000 },
      ],
      durationMs: 4_000,
      outputPath: "/t/out.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("[1:a]adelay=delays=200:all=1");
    expect(graph).toContain("[2:a]adelay=delays=2000:all=1");
    expect(graph).toContain("asplit=2");
    expect(graph).toContain("amix=inputs=5:normalize=0");
    expect(graph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-t", "4.000"]));
  });
});

describe("createStickmanMotionRenderer (real ffmpeg)", () => {
  let dir: string;
  let clip: Uint8Array;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "motion-test-"));
    const path = join(dir, "clip.wav");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=180:duration=1.4,volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame",
      "-ar",
      "24000",
      path,
    ]);
    clip = new Uint8Array(await readFile(path));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const plan = (
    extra: Readonly<{
      hook?: readonly ActorAction[];
      payoff?: readonly ActorAction[];
      canvas?: "landscape";
    }> = {},
  ) => {
    const timings = [
      timing(0, "Why is milk at the back", 1_400),
      timing(1_900, "because you walk past", 1_400),
    ];
    return planMotion({
      scenes: [
        scene(1, {
          purpose: "hook",
          overlays: [{ text: "WHY?", position: "top", emphasis: true }],
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "center",
              actions: [
                { type: "enter", atWord: 0, from: "left", durationMs: 900 },
                ...(extra.hook ?? []),
              ],
            },
          ],
        }),
        scene(2, {
          purpose: "payoff",
          transition: "wipe",
          props: [{ type: "milk_carton", position: "right" }],
          actors: [
            {
              characterKey: "alex",
              pose: "pointing",
              expression: "happy",
              position: "center",
              actions: extra.payoff,
            },
          ],
        }),
      ],
      timings,
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timings[1]?.endMs ?? 0,
      ...(extra.canvas ? { canvas: extra.canvas } : {}),
    });
  };
  const render = (motion: MotionPlan) =>
    createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
      plan: motion,
      voiceClips: [clip, clip],
      voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
    });
  let baselineRender: Promise<ReelRenderOutput> | undefined;
  /** The fixture without extra actions, rendered once and shared by the comparisons. */
  const baseline = async () => {
    baselineRender ??= render(plan());
    return (await baselineRender).bytes;
  };
  /** Decoded luma of the frame on screen at ms, full resolution. */
  const lumaAt = async (video: Uint8Array, ms: number, name: string): Promise<Buffer> => {
    const path = join(dir, `${name}.mp4`);
    await writeFile(path, video);
    const { stdout } = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        (ms / 1000).toFixed(3),
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  };
  /** Pixels whose luma moved by more than encoder noise. */
  const changedPixels = (a: Buffer, b: Buffer): number => {
    let count = 0;
    for (let i = 0; i < a.length; i += 1) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 40) count += 1;
    return count;
  };

  it("renders a 1080x1920 30 fps video with narration and effects that passes the quality gate", async () => {
    const motion = plan();
    const output = await createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
      plan: motion,
      voiceClips: [clip, clip],
      voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
    });
    expect(output).toMatchObject({ mimeType: "video/mp4", width: 1080, height: 1920 });
    expect(output.durationMs).toBe(motion.durationMs);
    const path = join(dir, "out.mp4");
    await writeFile(path, output.bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]);
    const streams = (
      JSON.parse(stdout) as { streams: { codec_type: string; r_frame_rate?: string }[] }
    ).streams;
    expect(streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect(output.quality?.verdict).not.toBe("block");
    // Idle breathing keeps standing actors alive for freezedetect (measured pass before idle gating).
    expect(output.quality?.checks.find((check) => check.id === "freeze")?.verdict).toBe("pass");
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    // Slice 12: stage timings ride on the output, never on the quality report (no render_notes warn).
    expect(output.timings.frames).toBe(Math.ceil((motion.durationMs / 1000) * 30));
    for (const stage of ["composeMs", "rasterMs", "writeMs", "encodeMs", "mixMs", "qaMs"] as const)
      expect(output.timings[stage]).toBeGreaterThanOrEqual(0);
    expect(output.timings.rasterMs).toBeGreaterThan(0);
    expect(output.timings.totalMs).toBeGreaterThanOrEqual(
      output.timings.composeMs + output.timings.rasterMs + output.timings.mixMs,
    );
    expect(output.timings.framesPerSec).toBeGreaterThan(0);
    expect(output.quality?.checks.find((check) => check.id === "render_notes")?.verdict).toBe(
      "pass",
    );
  }, 180_000);

  it("renders with the layer cache on and still passes the quality gate", async () => {
    const motion = plan();
    const output = await createStickmanMotionRenderer({
      timeoutMs: 120_000,
      layerCache: true,
    }).render({
      plan: motion,
      voiceClips: [clip, clip],
      voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
    });
    expect(output.durationMs).toBe(motion.durationMs);
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
  }, 180_000);

  describe("chunked render (long-form)", () => {
    const tiny = { targetMs: 1, minTotalMs: 0 } as const;
    const probe = async (bytes: Uint8Array, name: string) => {
      const path = join(dir, `${name}.mp4`);
      await writeFile(path, bytes);
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_packets",
        "-show_entries",
        "stream=codec_name,pix_fmt,nb_read_packets:format=duration",
        "-show_entries",
        "packet=size",
        "-of",
        "json",
        path,
      ]);
      const json = JSON.parse(stdout) as {
        streams: { codec_name: string; pix_fmt: string }[];
        packets: { size: string }[];
        format: { duration: string };
      };
      return {
        codec: json.streams[0]?.codec_name,
        pixFmt: json.streams[0]?.pix_fmt,
        sizes: json.packets.map((packet) => packet.size),
        duration: Number(json.format.duration),
      };
    };
    const renderChunked = (motion: MotionPlan, cache?: ChunkCache) =>
      createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
        plan: motion,
        voiceClips: [clip, clip],
        voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
        chunks: {
          sourceKey: "board-1",
          rendererVersion: 1,
          codeVersion: "t",
          cache,
          options: tiny,
        },
      });

    it("concatenates 2 chunks by stream copy, keeps the duration, and resumes after a failed last chunk", async () => {
      const motion = plan();
      const stored = new Map<string, Uint8Array>();
      const produced: string[] = [];
      let failLast = true;
      const cache: ChunkCache = async (identity, produce) => {
        const hit = stored.get(identity);
        if (hit) return hit;
        if (failLast && stored.size === 1) throw new Error("chunk_store_down");
        produced.push(identity);
        const bytes = await produce();
        stored.set(identity, bytes);
        return bytes;
      };
      // The last chunk fails: the first one is already stored.
      await expect(renderChunked(motion, cache)).rejects.toThrow("chunk_store_down");
      expect(stored.size).toBe(1);
      failLast = false;
      const output = await renderChunked(motion, cache);
      // Retry rendered only the missing chunk.
      expect(produced).toHaveLength(2);
      expect(new Set(produced).size).toBe(2);
      expect(output.timings.chunks).toBe(2);
      expect(output.timings.concatMs).toBeGreaterThan(0);
      expect(output.durationMs).toBe(motion.durationMs);
      expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);

      const chunks = await Promise.all(
        [...stored.values()].map((bytes, i) => probe(bytes, `c${i}`)),
      );
      const joined = await probe(output.bytes, "joined");
      expect(joined).toMatchObject({ codec: "h264", pixFmt: "yuv420p" });
      // Same encoded packets as the chunks, in order: joined without re-encoding. The only
      // difference the muxer may add is the in-band parameter sets (< 100 bytes) on each chunk's one keyframe.
      const expected = chunks.flatMap((chunk) => chunk.sizes.map(Number));
      expect(joined.sizes).toHaveLength(expected.length);
      joined.sizes.forEach((size, i) => {
        expect(Number(size) - (expected[i] ?? 0)).toBeLessThan(100);
        expect(Number(size) - (expected[i] ?? 0)).toBeGreaterThanOrEqual(0);
      });
      expect(
        joined.sizes.filter((size, i) => Number(size) !== expected[i]).length,
      ).toBeLessThanOrEqual(chunks.length);
      const single = await probe(await baseline(), "single");
      expect(Math.abs(joined.duration - single.duration)).toBeLessThan(0.05);
      expect(Math.abs(joined.duration - motion.durationMs / 1000)).toBeLessThan(0.1);
    }, 300_000);

    it("keeps a short plan on the single-pass path and never touches the chunk cache", async () => {
      const motion = plan();
      let touched = 0;
      const output = await createStickmanMotionRenderer({ timeoutMs: 120_000 }).render({
        plan: motion,
        voiceClips: [clip, clip],
        voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
        chunks: {
          sourceKey: "board-1",
          rendererVersion: 1,
          codeVersion: "t",
          cache: async (_identity, produce) => {
            touched += 1;
            return produce();
          },
        },
      });
      expect(touched).toBe(0);
      expect(output.timings).toMatchObject({ chunks: 1, concatMs: 0 });
      expect(output.durationMs).toBe(motion.durationMs);
    }, 180_000);
  });

  it("renders a 1920x1080 30 fps landscape video that passes the quality gate", async () => {
    const motion = plan({ canvas: "landscape" });
    const output = await createStickmanMotionRenderer({
      timeoutMs: 120_000,
      layerCache: true,
    }).render({
      plan: motion,
      voiceClips: [clip, clip],
      voiceStartMs: motion.scenes.map((entry) => entry.voiceStartMs),
    });
    expect(output).toMatchObject({ mimeType: "video/mp4", width: 1920, height: 1080 });
    const path = join(dir, "landscape.mp4");
    await writeFile(path, output.bytes);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-of",
      "json",
      path,
    ]);
    const [video] = (
      JSON.parse(stdout) as { streams: { width: number; height: number; r_frame_rate: string }[] }
    ).streams;
    expect(video).toMatchObject({ width: 1920, height: 1080, r_frame_rate: "30/1" });
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
  }, 240_000);

  it("shows point_at in the rendered pixels and still passes the quality gate", async () => {
    // The entrance ends at 1100 ms; word 4 ("the") starts at 1133 ms; the overlay is overhead.
    const pointing = await render(
      plan({
        hook: [
          { type: "point_at", atWord: 4, target: { kind: "overlay", index: 0 }, durationMs: 400 },
        ],
      }),
    );
    expect(pointing.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    const moved = changedPixels(
      await lumaAt(await baseline(), 1_333, "base"),
      await lumaAt(pointing.bytes, 1_333, "point"),
    );
    expect(moved).toBeGreaterThan(800);
  }, 180_000);

  it("shows look_at in the rendered pixels and still passes the quality gate", async () => {
    // Scene 2: word 1 ("you") starts at 2450 ms; the carton sits to the actor's right.
    const looking = await render(
      plan({
        payoff: [
          { type: "look_at", atWord: 1, target: { kind: "prop", index: 0 }, durationMs: 900 },
        ],
      }),
    );
    expect(looking.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    const moved = changedPixels(
      await lumaAt(await baseline(), 2_900, "base"),
      await lumaAt(looking.bytes, 2_900, "look"),
    );
    // Eyes, brows and mouth shift about 12 px: far fewer pixels than an arm, far more than noise.
    expect(moved).toBeGreaterThan(300);
  }, 180_000);

  it("shows an emote in the rendered pixels and still passes the quality gate", async () => {
    // Scene 2: word 0 starts at 2100 ms; a 1200 ms excited emote's first hop peaks near 2520 ms.
    const emoting = await render(
      plan({ payoff: [{ type: "emote", atWord: 0, emotion: "excited", durationMs: 1_200 }] }),
    );
    expect(emoting.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    const moved = changedPixels(
      await lumaAt(await baseline(), 2_520, "base"),
      await lumaAt(emoting.bytes, 2_520, "emote"),
    );
    expect(moved).toBeGreaterThan(800);
  }, 180_000);

  it("kills its encoder and leaves no temp files when aborted mid-render", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-abort-root-"));
    const controller = new AbortController();
    const rendering = createStickmanMotionRenderer({ timeoutMs: 120_000, tmpRoot: root }).render(
      { plan: plan(), voiceClips: [clip, clip], voiceStartMs: [200, 2_100] },
      { signal: controller.signal },
    );
    const running = async () =>
      (await run("ps", ["-eo", "args"])).stdout
        .split("\n")
        .filter((line) => line.includes(root) && line.startsWith("ffmpeg"));
    // Wait for the frame encoder itself, not the short sound-effect passes before it.
    const encoding = async () => (await running()).filter((line) => line.includes("rawvideo"));
    for (let i = 0; i < 200 && (await encoding()).length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await encoding()).length).toBe(1);
    controller.abort(new Error("render_timeout"));
    await expect(rendering).rejects.toThrow("render_aborted");
    expect(await running()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it("paints the background art edge to edge under the stage while the camera pans", async () => {
    const art = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 30, g: 110, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const timings = [
      timing(0, "Why is milk at the back", 1_400),
      timing(1_900, "because you walk past", 1_400),
    ];
    const motion = planMotion({
      scenes: [
        scene(1, {
          purpose: "hook",
          backgroundAssetId: "bg",
          camera: { shot: "medium", movement: "pan_right" },
        }),
        scene(2, { purpose: "payoff" }),
      ],
      timings,
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timings[1]?.endMs ?? 0,
      backgroundArt: new Map([
        ["bg", { href: `data:image/jpeg;base64,${art.toString("base64")}` }],
      ]),
    });
    const output = await render(motion);
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    const path = join(dir, "painted.mp4");
    await writeFile(path, output.bytes);
    for (const ms of [100, 1_800]) {
      const { stdout } = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          (ms / 1000).toFixed(3),
          "-i",
          path,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
      );
      for (const [x, y] of [
        [4, 4],
        [1075, 4],
        [4, 1915],
        [1075, 1915],
      ] as const) {
        const i = (y * 1080 + x) * 3;
        // Blue art under the vignette, never the cream surface (#F6F1E7): the bleed covers the pan.
        expect((stdout[i + 2] ?? 0) - (stdout[i] ?? 0)).toBeGreaterThan(60);
      }
    }
  }, 180_000);

  it("animates the painted background from ambient loop frames in a real render", async () => {
    const clipPath = join(dir, "ambient.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=216x384:r=30:d=2,format=yuv420p,geq=lum='128+60*sin(2*PI*(X/216+T/2))':cb=128:cr=128",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clipPath,
    ]);
    const frames = await extractLoopFrames(new Uint8Array(await readFile(clipPath)));
    const href = (bytes: Uint8Array) =>
      `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
    const timings = [
      timing(0, "Why is milk at the back", 1_400),
      timing(1_900, "because you walk past", 1_400),
    ];
    const motion = planMotion({
      scenes: [
        scene(1, { purpose: "hook", backgroundAssetId: "bg" }),
        scene(2, { purpose: "payoff" }),
      ],
      timings,
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timings[1]?.endMs ?? 0,
      backgroundArt: new Map([
        [
          "bg",
          {
            href: href(frames[0] ?? new Uint8Array()),
            loop: { frames: frames.map(href), fps: 30 },
          },
        ],
      ]),
    });
    const output = await render(motion);
    expect(output.quality?.checks.filter((check) => check.verdict === "block")).toEqual([]);
    // The top 280 rows hold only background in scene 1: with a still they would not change.
    const band = 280 * 1080;
    const moved = changedPixels(
      (await lumaAt(output.bytes, 200, "loop-a")).subarray(0, band),
      (await lumaAt(output.bytes, 700, "loop-b")).subarray(0, band),
    );
    expect(moved).toBeGreaterThan(20_000);
  }, 180_000);
});

describe("hand-drawn line style through sharp/librsvg", () => {
  it("rasterises sketch frames deterministically, visibly different, within the frame budget", async () => {
    const make = (lineStyle: "clean" | "sketch") =>
      planMotion({
        scenes: [scene(1, { purpose: "hook" })],
        timings: [timing(0, "why is milk at the back", 1_400)],
        characters: [alex],
        palette: DEFAULT_SCENE_PALETTE,
        captionWords: 3,
        durationMs: 1_900,
        lineStyle,
      });
    const raster = (svg: string) =>
      sharp(Buffer.from(svg), { density: 72 }).removeAlpha().raw().toBuffer();
    const sketch = make("sketch");
    const first = await raster(composeMotionFrame(sketch, 700));
    expect((await raster(composeMotionFrame(sketch, 700))).equals(first)).toBe(true);
    const clean = await raster(composeMotionFrame(make("clean"), 700));
    let changed = 0;
    for (let i = 0; i < first.length; i += 3)
      if (Math.abs((first[i] ?? 0) - (clean[i] ?? 0)) > 40) changed += 1;
    expect(changed).toBeGreaterThan(500);
    // Measured 2026-09-30 (librsvg 2.62.91): feTurbulence + feDisplacementMap cost ~2.1 s per
    // 1080x1920 frame; geometry keeps a sketch frame in the same range as a clean one (~10 ms).
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) await raster(composeMotionFrame(sketch, 700 + i * 33));
    expect((performance.now() - started) / 10).toBeLessThan(250);
  });
});
