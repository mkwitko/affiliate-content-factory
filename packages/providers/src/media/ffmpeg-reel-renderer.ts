import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { musicGain } from "@money-maker/core/assets/reel-music";
import type {
  ReelRenderer,
  ReelRenderInput,
  ReelRenderOutput,
  ReelSlideInput,
  RenderCallOptions,
} from "@money-maker/core/assets/reel-renderer";
import { wavDurationMs } from "@money-maker/core/assets/wav-duration";
import { evaluateRenderQuality, gapsBetween } from "@money-maker/core/publishing/render-quality";
import sharp from "sharp";
import { buildFfmpegArgs, V2_TRANSITION_SEC } from "./ffmpeg-args.js";
import { buildCaptionAss } from "./reel-captions.js";
import { runProcess } from "./run-process.js";
import { measureRenderedVideo } from "./video-quality-probe.js";

const outputWidth = 1080;
const outputHeight = 1920;
// A 4:5 slide is composited onto a blurred, darkened copy of itself filling the 9:16 frame;
// a slide already close to 9:16 (Stories-shaped) is simply cropped to fill it.
const fullBleedAspectTolerance = 0.05;

const isFullBleed = (width: number, height: number, targetAspect: number): boolean =>
  height > 0 && Math.abs(width / height - targetAspect) < fullBleedAspectTolerance;

/** Composites one slide onto the exact 1080x1920 output canvas as a JPEG buffer. */
export const composeSlideFrame = async (
  slide: ReelSlideInput,
  width = outputWidth,
  height = outputHeight,
): Promise<Buffer> => {
  if (isFullBleed(slide.width, slide.height, width / height)) {
    return sharp(slide.bytes)
      .resize(width, height, { fit: "cover" })
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  const background = await sharp(slide.bytes)
    .resize(width, height, { fit: "cover" })
    .blur(30)
    .modulate({ brightness: 0.55 })
    .toBuffer();
  const foreground = await sharp(slide.bytes).resize({ width }).toBuffer();
  return sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .jpeg({ quality: 90 })
    .toBuffer();
};

const brightBackground = 140;

/** Light logo on dark footage, dark logo on bright footage; the light one when brightness is unknown. */
export const pickMarkLogo = async (
  mark: Pick<NonNullable<ReelRenderInput["mark"]>, "logoLight" | "logoDark">,
  firstFrame: Uint8Array,
): Promise<Uint8Array | undefined> => {
  if (!mark.logoLight || !mark.logoDark) return mark.logoLight ?? mark.logoDark;
  try {
    const [r, g, b] = (await sharp(firstFrame).stats()).channels.map((c) => c.mean);
    const luma = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    return luma > brightBackground ? mark.logoDark : mark.logoLight;
  } catch {
    return mark.logoLight;
  }
};

export type FfmpegReelRendererOptions = Readonly<{
  ffmpegPath?: string;
  slideDurationSec?: number;
  crossfadeSec?: number;
  /** Kills ffmpeg past this many ms. Default 3 minutes (voiced renders take longer). */
  timeoutMs?: number;
  /** Caps input slide count; the source channel (instagram_carousel) already caps at 10. */
  maxSlides?: number;
  maxDurationSec?: number;
  maxOutputBytes?: number;
  /** Parent of the per-render temporary directory; default os.tmpdir(). */
  tmpRoot?: string;
  /** Caps ffmpeg's encoder threads (RENDER_THREADS); absent lets ffmpeg decide. */
  threads?: number;
  /** Reel edit language (ffmpeg-args `editStyle`); REEL_EDIT_STYLE=v2 opts in. Default v1. */
  editStyle?: "v1" | "v2";
}>;

/** Shared by every renderer so the worker can sweep what a killed process left behind. */
export const RENDER_TEMP_PREFIX = "money-maker-render-";

const isAbort = (error: unknown, signal: AbortSignal | undefined): boolean =>
  !!signal?.aborted ||
  (typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError");

export const createFfmpegReelRenderer = (options?: FfmpegReelRendererOptions): ReelRenderer => {
  const ffmpegPath = options?.ffmpegPath ?? "ffmpeg";
  const v2 = options?.editStyle === "v2";
  const slideDurationSec = options?.slideDurationSec ?? (v2 ? 3 : 4);
  const crossfadeSec = options?.crossfadeSec ?? (v2 ? V2_TRANSITION_SEC : 0.8);
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const maxSlides = options?.maxSlides ?? 10;
  const maxDurationSec = options?.maxDurationSec ?? 60;
  const maxOutputBytes = options?.maxOutputBytes ?? 150_000_000;

  return {
    crossfadeSec,
    async render(input: ReelRenderInput, call?: RenderCallOptions): Promise<ReelRenderOutput> {
      const signal = call?.signal;
      const checkAbort = () => {
        if (signal?.aborted) throw new Error("render_aborted");
      };
      checkAbort();
      if (input.slides.length === 0 || input.slides.length > maxSlides) {
        throw new Error("reel_slide_count_invalid");
      }
      if (
        input.voiceClips &&
        (!input.timeline || input.voiceClips.length !== input.slides.length)
      ) {
        throw new Error("reel_voice_clip_count_invalid");
      }
      const dir = await mkdtemp(join(options?.tmpRoot ?? tmpdir(), `${RENDER_TEMP_PREFIX}reel-`));
      try {
        const width = input.canvas === "landscape" ? 1920 : outputWidth;
        const height = input.canvas === "landscape" ? 1080 : outputHeight;
        const slidePaths: string[] = [];
        // A generated scene clip (ai_clips) arrives as an mp4 and is scaled inside ffmpeg.
        const videoSlides = input.slides.map((slide) => slide.mimeType === "video/mp4");
        for (const [index, slide] of input.slides.entries()) {
          checkAbort();
          const isVideo = videoSlides[index] === true;
          const path = join(dir, isVideo ? `slide-${index}.mp4` : `slide-${index}.jpg`);
          await writeFile(
            path,
            isVideo ? slide.bytes : await composeSlideFrame(slide, width, height),
          );
          slidePaths.push(path);
        }

        const clipPaths: string[] = [];
        for (const [index, clip] of (input.voiceClips ?? []).entries()) {
          const path = join(dir, `voice-${index}.wav`);
          await writeFile(path, clip);
          clipPaths.push(path);
        }

        const ass = input.timeline ? buildCaptionAss(input.timeline, input.captionStyle) : null;
        const captionsPath = ass ? join(dir, "captions.ass") : undefined;
        if (ass && captionsPath) await writeFile(captionsPath, ass, "utf8");

        let markPath: string | undefined;
        if (input.mark) {
          const logo = await pickMarkLogo(input.mark, await readFile(slidePaths[0] as string));
          if (logo) {
            markPath = join(dir, "mark.png");
            await writeFile(markPath, await sharp(logo).png().toBuffer());
          }
        }

        const outputPath = join(dir, "output.mp4");
        checkAbort();
        const { args, totalDurationSec, plannedStill } = buildFfmpegArgs({
          slidePaths,
          ...(videoSlides.some(Boolean) ? { videoSlides } : {}),
          outputPath,
          ...(input.motions ? { motions: input.motions } : {}),
          ...(options?.editStyle ? { editStyle: options.editStyle } : {}),
          // A voice timeline fixes the overlap its voice start times were computed with.
          crossfadeSec: input.timeline?.crossfadeSec ?? crossfadeSec,
          width,
          height,
          ...(input.timeline
            ? { slideDurationsSec: input.timeline.slides.map((s) => s.durationSec) }
            : { slideDurationSec }),
          ...(input.musicFile ? { musicPath: input.musicFile } : {}),
          ...(clipPaths.length > 0 && input.timeline
            ? {
                voice: {
                  clipPaths,
                  startSec: input.timeline.slides.map((s) => s.voiceStartSec),
                },
              }
            : {}),
          ...(captionsPath ? { captionsPath } : {}),
          ...(input.musicVolume ? { musicGain: musicGain[input.musicVolume] } : {}),
          ...(input.mark && markPath
            ? {
                mark: {
                  path: markPath,
                  opacity: input.mark.opacity,
                  position: input.mark.position,
                  width: input.mark.minWidth,
                  safeMargin: input.mark.safeMargin,
                },
              }
            : {}),
        });
        if (totalDurationSec > maxDurationSec)
          throw new Error(maxDurationSec <= 60 ? "reel_too_long" : "long_form_too_long");
        const threadArgs = options?.threads ? ["-threads", String(options.threads)] : [];
        try {
          await runProcess(ffmpegPath, [...threadArgs, ...args], {
            timeoutMs,
            maxBuffer: 1024 * 1024,
            signal,
          });
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message === "render_aborted"
              ? "render_aborted"
              : "reel_render_failed",
          );
        }
        const outputSize = (await stat(outputPath)).size;
        if (outputSize > maxOutputBytes) throw new Error("render_output_too_large");
        const durationMs = Math.round(totalDurationSec * 1000);
        const voiceRanges = (input.voiceClips ?? []).map((clip, index) => {
          const startMs = Math.round((input.timeline?.slides[index]?.voiceStartSec ?? 0) * 1000);
          return { startMs, endMs: startMs + wavDurationMs(clip) };
        });
        const hasVoice = voiceRanges.length > 0;
        const quality = evaluateRenderQuality(await measureRenderedVideo(outputPath, { signal }), {
          width,
          height,
          fps: 30,
          durationMs,
          audioRequired: hasVoice || !!input.musicFile,
          plannedStill,
          // Music fills the pauses; without it the gaps between clips are silent by design.
          plannedSilence: hasVoice && !input.musicFile ? gapsBetween(voiceRanges, durationMs) : [],
          plannedDark: [],
        });
        const bytes = await readFile(outputPath);
        return {
          bytes: new Uint8Array(bytes),
          mimeType: "video/mp4",
          width,
          height,
          durationMs,
          quality,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
