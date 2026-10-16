import type { RenderTimingManifest } from "./render-timing-manifest.js";

export type OwnedClipCaptionWord = Readonly<{
  text: string;
  startMs: number;
  endMs: number;
}>;

export const buildOwnedClipCaptionWords = (input: {
  manifest: RenderTimingManifest;
  startMs: number;
  endMs: number;
}): readonly OwnedClipCaptionWord[] | null => {
  if (
    input.manifest.alignmentStatus !== "aligned" ||
    !Number.isSafeInteger(input.startMs) ||
    !Number.isSafeInteger(input.endMs) ||
    input.startMs < 0 ||
    input.endMs <= input.startMs ||
    input.endMs > input.manifest.durationMs
  )
    return null;

  return input.manifest.words.flatMap((word) => {
    if (word.startMs >= input.endMs || word.endMs <= input.startMs) return [];
    return [
      {
        text: word.text,
        startMs: Math.max(0, word.startMs - input.startMs),
        endMs: Math.min(input.endMs, word.endMs) - input.startMs,
      },
    ];
  });
};
