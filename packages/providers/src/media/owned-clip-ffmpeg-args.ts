import type { OwnedClipLayout } from "@money-maker/core/assets/clip-renderer";
import { escapeFilterPath } from "./ffmpeg-args.js";

export const buildOwnedClipFfmpegArgs = (input: {
  inputPath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  layout?: OwnedClipLayout;
  captionsPath?: string;
  /** vertical_focus: crop window and its sendcmd file; absent renders the blurred fill. */
  focus?: { cropWidth: number; initialX: number; commandsPath: string };
}): readonly string[] => {
  if (
    !Number.isSafeInteger(input.startMs) ||
    !Number.isSafeInteger(input.endMs) ||
    input.startMs < 0 ||
    input.endMs <= input.startMs ||
    input.endMs - input.startMs > 180_000
  )
    throw new Error("clip_boundaries_invalid");
  const captions = input.captionsPath
    ? `,subtitles=filename=${escapeFilterPath(input.captionsPath)}`
    : "";
  const focus = input.layout === "vertical_focus" ? input.focus : undefined;
  const blur = (input.layout === "vertical_blur" || input.layout === "vertical_focus") && !focus;
  return [
    "-y",
    "-threads",
    "2",
    "-i",
    input.inputPath,
    "-ss",
    (input.startMs / 1000).toFixed(3),
    "-t",
    ((input.endMs - input.startMs) / 1000).toFixed(3),
    ...(focus
      ? [
          "-filter_complex",
          `[0:v]sendcmd=f=${escapeFilterPath(focus.commandsPath)},crop@c=w=${focus.cropWidth}:h=ih:x=${focus.initialX}:y=0,scale=1080:1920${captions}[v]`,
          "-map",
          "[v]",
        ]
      : blur
        ? [
            "-filter_complex",
            `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:5[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${captions}[v]`,
            "-map",
            "[v]",
          ]
        : ["-map", "0:v:0"]),
    "-map",
    "0:a?",
    ...(input.layout === "vertical"
      ? [
          "-vf",
          `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black${captions}`,
        ]
      : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
};

/**
 * sendcmd script moving the crop window at each scene cut inside the clip. Times are source time
 * (the clip is cut with an output-side -ss, so the filter graph still sees source timestamps).
 */
export const buildFocusSendcmd = (
  points: readonly { tMs: number; x: number }[],
  startMs: number,
  endMs: number,
): { initialX: number; text: string } => {
  const before = points.filter((point) => point.tMs <= startMs).at(-1) ?? points[0];
  const inside = points.filter((point) => point.tMs > startMs && point.tMs < endMs);
  return {
    initialX: before?.x ?? 0,
    text: inside.map((point) => `${(point.tMs / 1000).toFixed(3)} crop@c x ${point.x};\n`).join(""),
  };
};
