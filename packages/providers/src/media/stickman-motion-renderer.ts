import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReelRenderOutput, RenderCallOptions } from "@money-maker/core/assets/reel-renderer";
import { geometryFor } from "@money-maker/core/explainer/layout";
import {
  type ChunkCache,
  type ChunkOptions,
  chunkIdentity,
  frameCount,
  planChunks,
} from "@money-maker/core/explainer/motion/chunks";
import { composeMotionFrame, vignetteMaskSvg } from "@money-maker/core/explainer/motion/frame";
import type { MotionPlan, SfxCue, SfxId } from "@money-maker/core/explainer/motion/plan";
import { evaluateRenderQuality } from "@money-maker/core/publishing/render-quality";
import sharp from "sharp";
import { RENDER_TEMP_PREFIX } from "./ffmpeg-reel-renderer.js";
import { runProcess } from "./run-process.js";
import { createStageTimer, type RenderTimings, summarizeTimings } from "./stage-timer.js";
import { measureRenderedVideo } from "./video-quality-probe.js";

export type { RenderTimings } from "./stage-timer.js";

const FPS = 30;
/** Frames rasterized concurrently; sharp's thread pool does the work. */
const RASTER_BATCH = 4;
const SFX_GAIN = 0.35;

/**
 * Synthesised sound effects (ffmpeg lavfi), generated per render so no audio file is committed.
 * Short, quiet and dry: they punctuate the narration, never cover it.
 */
const SFX_SOURCES: Readonly<Record<SfxId, string>> = {
  pop: "aevalsrc='0.6*sin(2*PI*(600+900*t)*t)*exp(-t*28)':d=0.12:s=48000",
  whoosh:
    "anoisesrc=d=0.35:c=pink:a=0.5:r=48000,highpass=f=400,lowpass=f=3000,afade=t=in:d=0.12,afade=t=out:st=0.15:d=0.2",
  ding: "aevalsrc='0.5*sin(2*PI*1320*t)*exp(-t*5)+0.25*sin(2*PI*1980*t)*exp(-t*6)':d=0.9:s=48000",
  thud: "aevalsrc='0.9*sin(2*PI*(90-40*t)*t)*exp(-t*14)':d=0.3:s=48000",
  tick: "aevalsrc='0.4*sin(2*PI*2400*t)*exp(-t*90)':d=0.05:s=48000",
};

const vignetteMasks = new Map<string, Promise<Buffer>>();
/** The cached vignette multiplier, one byte per pixel (slice 17); rasterised once per process and canvas. */
const vignetteMaskOnce = (canvas: MotionPlan["canvas"]): Promise<Buffer> => {
  const key = canvas ?? "portrait";
  let mask = vignetteMasks.get(key);
  if (!mask) {
    mask = sharp(Buffer.from(vignetteMaskSvg(canvas)), { density: 72 })
      .removeAlpha()
      .extractChannel(0)
      .raw()
      .toBuffer();
    vignetteMasks.set(key, mask);
  }
  return mask;
};
/** Multiplies a raw RGB frame by the vignette mask in place: out = in × mask / 255, rounded. */
export const applyVignette = (frame: Buffer, mask: Buffer): Buffer => {
  for (let p = 0, i = 0; p < mask.length; p += 1, i += 3) {
    const f = mask[p] ?? 255;
    if (f === 255) continue;
    frame[i] = ((frame[i] ?? 0) * f + 127) / 255;
    frame[i + 1] = ((frame[i + 1] ?? 0) * f + 127) / 255;
    frame[i + 2] = ((frame[i + 2] ?? 0) * f + 127) / 255;
  }
  return frame;
};

/** Pure: the mux pass that lays narration and cues over the silent video; exported for tests. */
export const buildMotionAudioArgs = (input: {
  videoPath: string;
  voicePaths: readonly string[];
  voiceStartMs: readonly number[];
  /** Dialogue (slice 32): per clip, where to cut it and from when to duck it, ms into the clip. */
  voiceEdits?: readonly (VoiceEdit | undefined)[] | undefined;
  sfxPaths: Readonly<Partial<Record<SfxId, string>>>;
  cues: readonly SfxCue[];
  durationMs: number;
  outputPath: string;
}): readonly string[] => {
  const sfxIds = (Object.keys(input.sfxPaths) as SfxId[]).filter((id) =>
    input.cues.some((cue) => cue.id === id),
  );
  const sfxIndex = new Map(sfxIds.map((id, i) => [id, 1 + input.voicePaths.length + i]));
  const filters: string[] = [];
  const mix: string[] = [];
  input.voicePaths.forEach((_path, i) => {
    const delay = Math.max(0, Math.round(input.voiceStartMs[i] ?? 0));
    const edit = input.voiceEdits?.[i];
    const trim = edit?.trimMs !== undefined ? `atrim=end=${(edit.trimMs / 1000).toFixed(3)},` : "";
    // An interrupted line's tail plays under the interrupter at -10 dB (the comma is escaped
    // inside the filtergraph expression).
    const duck =
      edit?.duckFromMs !== undefined
        ? `volume=${DUCK_DB}dB:enable='gte(t\\,${(edit.duckFromMs / 1000).toFixed(3)})',`
        : "";
    filters.push(`[${1 + i}:a]${trim}${duck}adelay=delays=${delay}:all=1[vo${i}]`);
    mix.push(`[vo${i}]`);
  });
  for (const id of sfxIds) {
    const cues = input.cues.filter((cue) => cue.id === id);
    const labels = cues.map((_cue, j) => `[${id}${j}]`).join("");
    filters.push(`[${sfxIndex.get(id)}:a]asplit=${cues.length}${labels}`);
    cues.forEach((cue, j) => {
      const delay = Math.max(0, Math.round(cue.atMs));
      filters.push(`[${id}${j}]adelay=delays=${delay}:all=1,volume=${SFX_GAIN}[c${id}${j}]`);
      mix.push(`[c${id}${j}]`);
    });
  }
  const seconds = (input.durationMs / 1000).toFixed(3);
  filters.push(
    `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=longest,apad,atrim=0:${seconds},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`,
  );
  return [
    "-y",
    "-v",
    "error",
    "-i",
    input.videoPath,
    ...input.voicePaths.flatMap((path) => ["-i", path]),
    ...sfxIds.flatMap((id) => ["-i", input.sfxPaths[id] as string]),
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    seconds,
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
};

export type VoiceEdit = Readonly<{ trimMs?: number | undefined; duckFromMs?: number | undefined }>;
const DUCK_DB = -10;
export type StickmanMotionRenderInput = Readonly<{
  plan: MotionPlan;
  /** Narration clips (one per scene, or one per dialogue line), placed at voiceStartMs. */
  voiceClips: readonly Uint8Array[];
  voiceStartMs: readonly number[];
  voiceEdits?: readonly (VoiceEdit | undefined)[] | undefined;
  /**
   * Long-form: plans longer than the chunk threshold render as separate chunk videos that are
   * concatenated without re-encoding. `cache`, when given, stores each finished chunk under its
   * identity so a retry skips the chunks that already completed. Absent renders in one pass.
   */
  chunks?:
    | Readonly<{
        sourceKey: string;
        rendererVersion: number;
        codeVersion: string;
        cache?: ChunkCache | undefined;
        options?: ChunkOptions | undefined;
      }>
    | undefined;
}>;
/** The reel output plus where the wall time went (video slice 12, B1); never in the quality report. */
export type StickmanMotionRenderOutput = ReelRenderOutput & Readonly<{ timings: RenderTimings }>;
export interface StickmanMotionRenderer {
  render(
    input: StickmanMotionRenderInput,
    options?: RenderCallOptions,
  ): Promise<StickmanMotionRenderOutput>;
}

export const writeFrame = (child: ChildProcess, frame: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) {
      reject(new Error("render_encoder_closed"));
      return;
    }
    if (stdin.write(frame)) resolve();
    else {
      const onDrain = () => {
        stdin.off("close", onClose);
        resolve();
      };
      const onClose = () => {
        stdin.off("drain", onDrain);
        reject(new Error("render_encoder_closed"));
      };
      stdin.once("drain", onDrain);
      stdin.once("close", onClose);
    }
  });

/**
 * Renders a MotionPlan: every frame composed as SVG (core), rasterized with sharp and piped raw
 * into libx264; narration and synthesised cues are then mixed and loudness-normalised, and the
 * result goes through the post-render quality gate. Encoders are killed and the temp directory
 * removed on every exit path, including an aborted signal.
 */
export const createStickmanMotionRenderer = (
  options: Readonly<{
    ffmpegPath?: string;
    /** Kills each ffmpeg pass past this many ms. */
    timeoutMs?: number;
    threads?: number;
    tmpRoot?: string;
    maxOutputBytes?: number;
    /**
     * STICKMAN_LAYER_CACHE (v2 slice 17): draw the static vignette layer once and apply it to
     * each raw frame instead of rasterising its gradient every frame. Pixel parity is tested.
     */
    layerCache?: boolean;
  }> = {},
): StickmanMotionRenderer => {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 540_000;
  const threadArgs = options.threads ? ["-threads", String(options.threads)] : [];
  return {
    async render(input, call) {
      const signal = call?.signal;
      if (signal?.aborted) throw new Error("render_aborted");
      if (input.voiceClips.length !== input.voiceStartMs.length)
        throw new Error("motion_voice_clip_count_invalid");
      const { width: WIDTH, height: HEIGHT } = geometryFor(input.plan.canvas).frame;
      const startedAt = performance.now();
      const timer = createStageTimer();
      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `${RENDER_TEMP_PREFIX}motion-`));
      try {
        const voicePaths: string[] = [];
        for (const [i, clip] of input.voiceClips.entries()) {
          const path = join(dir, `voice-${i}.wav`);
          await writeFile(path, clip);
          voicePaths.push(path);
        }
        const usedSfx = [...new Set(input.plan.sfx.map((cue) => cue.id))];
        const sfxPaths: Partial<Record<SfxId, string>> = {};
        for (const id of usedSfx) {
          const path = join(dir, `sfx-${id}.wav`);
          await runProcess(
            ffmpeg,
            ["-v", "error", "-y", "-f", "lavfi", "-i", SFX_SOURCES[id], "-ac", "1", path],
            {
              timeoutMs: 30_000,
              signal,
            },
          );
          sfxPaths[id] = path;
        }

        const frames = frameCount(input.plan);
        const mask = options.layerCache ? await vignetteMaskOnce(input.plan.canvas) : undefined;
        /** Pipes frames [startFrame, endFrame) of the plan clock into one libx264 pass. */
        const encodeRange = async (
          startFrame: number,
          endFrame: number,
          videoPath: string,
        ): Promise<void> => {
          let encoder: ChildProcess | undefined;
          const encoding = runProcess(
            ffmpeg,
            [
              "-v",
              "error",
              "-y",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "-s",
              `${WIDTH}x${HEIGHT}`,
              "-r",
              String(FPS),
              "-i",
              "pipe:0",
              ...threadArgs,
              "-c:v",
              "libx264",
              "-preset",
              "medium",
              "-crf",
              "18",
              "-pix_fmt",
              "yuv420p",
              "-r",
              String(FPS),
              videoPath,
            ],
            {
              timeoutMs,
              signal,
              stdin: "pipe",
              onSpawn: (child) => {
                encoder = child;
                // A killed encoder closes its pipe; the frame loop sees it and stops.
                child.stdin?.on("error", () => undefined);
              },
            },
          );
          // Surfaces the encoder's own outcome (abort, timeout, crash) instead of a pipe error.
          const encoded = encoding.then(
            () => null,
            (error: unknown) => error,
          );
          try {
            for (let first = startFrame; first < endFrame; first += RASTER_BATCH) {
              if (signal?.aborted) break;
              // Composition is synchronous, so it ran before any rasterisation here as well.
              timer.mark("compose");
              const svgs = Array.from(
                { length: Math.min(RASTER_BATCH, endFrame - first) },
                (_, i) =>
                  Buffer.from(
                    composeMotionFrame(input.plan, ((first + i) * 1000) / FPS, {
                      vignette: !mask,
                    }),
                  ),
              );
              timer.stop("compose");
              const batch = await timer.time("raster", async () => {
                const frames = await Promise.all(
                  svgs.map((svg) => sharp(svg, { density: 72 }).removeAlpha().raw().toBuffer()),
                );
                if (!mask) return frames;
                return frames.map((frame) => applyVignette(frame, mask));
              });
              timer.mark("write");
              for (const frame of batch) {
                if (!encoder) throw new Error("render_encoder_closed");
                await writeFrame(encoder, frame);
              }
              timer.stop("write");
            }
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "render_encoder_closed") {
              encoder?.kill("SIGKILL");
              await encoded;
              throw error;
            }
          } finally {
            encoder?.stdin?.end();
          }
          const encodeError = await timer.time("encode", () => encoded);
          if (encodeError)
            throw new Error(
              encodeError instanceof Error && encodeError.message === "render_aborted"
                ? "render_aborted"
                : "motion_encode_failed",
            );
          if (signal?.aborted) throw new Error("render_aborted");
        };

        const chunks = input.chunks
          ? planChunks(input.plan, input.chunks.options)
          : planChunks(input.plan, { minTotalMs: Number.POSITIVE_INFINITY });
        const videoPath = join(dir, "video.mp4");
        if (chunks.length === 1) {
          await encodeRange(0, frames, videoPath);
        } else {
          const chunkPaths: string[] = [];
          for (const chunk of chunks) {
            const path = join(dir, `chunk-${chunk.index}.mp4`);
            const produce = async (): Promise<Uint8Array> => {
              await encodeRange(chunk.startFrame, chunk.endFrame, path);
              return new Uint8Array(await readFile(path));
            };
            const cache = input.chunks?.cache;
            if (cache) {
              const identity = chunkIdentity({
                plan: input.plan,
                chunk,
                sourceKey: input.chunks?.sourceKey ?? "",
                rendererVersion: input.chunks?.rendererVersion ?? 0,
                codeVersion: input.chunks?.codeVersion ?? "",
                width: WIDTH,
                height: HEIGHT,
                layerCache: Boolean(options.layerCache),
              });
              await writeFile(path, await cache(identity, produce));
            } else await produce();
            if (signal?.aborted) throw new Error("render_aborted");
            chunkPaths.push(path);
          }
          // Concat demuxer, stream copy: every chunk used identical encoder settings, so the
          // video is never re-encoded and audio is muxed once over the joined result below.
          const listPath = join(dir, "chunks.txt");
          await writeFile(listPath, chunkPaths.map((path) => `file '${path}'\n`).join(""));
          timer.mark("concat");
          try {
            await runProcess(
              ffmpeg,
              [
                "-v",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                listPath,
                "-c",
                "copy",
                videoPath,
              ],
              { timeoutMs, signal },
            );
          } catch (error) {
            throw new Error(
              error instanceof Error && error.message === "render_aborted"
                ? "render_aborted"
                : "motion_concat_failed",
            );
          } finally {
            timer.stop("concat");
          }
        }

        const outputPath = join(dir, "output.mp4");
        timer.mark("mix");
        try {
          await runProcess(
            ffmpeg,
            buildMotionAudioArgs({
              videoPath,
              voicePaths,
              voiceStartMs: input.voiceStartMs,
              ...(input.voiceEdits ? { voiceEdits: input.voiceEdits } : {}),
              sfxPaths,
              cues: input.plan.sfx,
              durationMs: input.plan.durationMs,
              outputPath,
            }),
            { timeoutMs, signal },
          );
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message === "render_aborted"
              ? "render_aborted"
              : "motion_mix_failed",
          );
        } finally {
          timer.stop("mix");
        }
        if ((await stat(outputPath)).size > (options.maxOutputBytes ?? 250_000_000))
          throw new Error("render_output_too_large");
        timer.mark("qa");
        const quality = evaluateRenderQuality(await measureRenderedVideo(outputPath, { signal }), {
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationMs: input.plan.durationMs,
          audioRequired: true,
          plannedStill: [],
          plannedSilence: input.plan.plannedSilence,
          plannedDark: input.plan.plannedDark,
          notes: input.plan.notes,
        });
        timer.stop("qa");
        const bytes = new Uint8Array(await readFile(outputPath));
        return {
          bytes,
          mimeType: "video/mp4",
          width: WIDTH,
          height: HEIGHT,
          durationMs: input.plan.durationMs,
          quality,
          timings: summarizeTimings({
            frames,
            chunks: chunks.length,
            stages: timer.read(),
            totalMs: performance.now() - startedAt,
          }),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
