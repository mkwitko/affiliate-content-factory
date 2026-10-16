import type { ResolvedCaptionTheme } from "../brand/caption-style.js";
import type { OwnedClipCaptionWord } from "../publishing/owned-clip-captions.js";

export const OWNED_CLIP_LAYOUTS = [
  "source",
  "vertical",
  "vertical_blur",
  "vertical_focus",
] as const;
export type OwnedClipLayout = (typeof OWNED_CLIP_LAYOUTS)[number];
/** Layouts that output 1080x1920. */
export const isVerticalLayout = (layout: unknown): boolean =>
  layout === "vertical" || layout === "vertical_blur" || layout === "vertical_focus";

export type ClipRenderOutput = Readonly<{
  bytes: Uint8Array;
  mimeType: "video/mp4";
  width: number;
  height: number;
  durationMs: number;
}>;

export interface ClipRenderer {
  render(input: {
    sourceBytes: Uint8Array;
    startMs: number;
    endMs: number;
    width: number;
    height: number;
    layout?: OwnedClipLayout;
    captionWords?: readonly OwnedClipCaptionWord[];
    /** Resolved niche caption theme; absent keeps the legacy clip caption style. */
    captionTheme?: ResolvedCaptionTheme;
    /** vertical_focus only: crop window per scene cut (source time); absent renders vertical_blur. */
    focusTrack?: Readonly<{
      cropWidth: number;
      points: readonly Readonly<{ tMs: number; x: number }>[];
    }>;
  }): Promise<ClipRenderOutput>;
}
