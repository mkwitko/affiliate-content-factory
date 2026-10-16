import type { ResolvedCaptionTheme } from "../brand/caption-style.js";
/**
 * A replaceable rendering port: turns ordered carousel slide images into one short vertical
 * video. Core defines only the shape; packages/providers holds the ffmpeg implementation so
 * core never depends on child_process or a binary on PATH.
 */
import type { RenderQualityReport } from "../publishing/render-quality.js";
import type { ReelTimeline } from "./reel-timeline.js";

export type ReelSlideInput = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}>;

/** Brand logo overlaid on every frame; the renderer picks the variant by the first frame's brightness. */
export type ReelMarkInput = Readonly<{
  logoLight?: Uint8Array;
  logoDark?: Uint8Array;
  opacity: number;
  position: "top-left" | "top-right" | "bottom-left";
  minWidth: number;
  safeMargin: number;
}>;

export type ReelRenderInput = Readonly<{
  slides: readonly ReelSlideInput[];
  /** Reels default to portrait; long-form composition can choose landscape. */
  canvas?: "portrait" | "landscape";
  motions?: readonly ("static" | "ken_burns_in" | "ken_burns_out" | "pan_left" | "pan_right")[];
  /** Background track locator from MusicLibrary; absent renders a silent Reel. */
  musicFile?: string;
  /** Slide timings; absent means the renderer's fixed slide duration (today). */
  timeline?: ReelTimeline;
  /** One WAV per slide, aligned with slides; requires timeline. */
  voiceClips?: readonly Uint8Array[];
  /** Caption placement override; media niches lift captions into their band above the UI. */
  mark?: ReelMarkInput;
  /** Background music level relative to today's; absent is medium. */
  musicVolume?: "low" | "medium" | "high";
  captionStyle?: Readonly<{
    marginV?: number;
    groupSize?: number;
    boxed?: boolean;
    /** Resolved niche caption theme; replaces the other fields when set. */
    theme?: ResolvedCaptionTheme;
  }>;
}>;

export type ReelRenderOutput = Readonly<{
  bytes: Uint8Array;
  mimeType: "video/mp4";
  width: number;
  height: number;
  durationMs: number;
  /** Post-render quality gate result; absent means the file was not measured. */
  quality?: RenderQualityReport;
}>;

/** An aborted signal kills the encoder, removes temporary files and rejects with render_aborted. */
export type RenderCallOptions = Readonly<{ signal?: AbortSignal | undefined }>;

export interface ReelRenderer {
  render(input: ReelRenderInput, options?: RenderCallOptions): Promise<ReelRenderOutput>;
  /** Seconds consecutive slides overlap; a voice timeline must be built with the same value. */
  readonly crossfadeSec?: number;
}
