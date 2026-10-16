import type { SpokenWord } from "./speech-synthesizer.js";

/**
 * Builds the crossfade and voice timing for a Reel's slides, pure so it can be unit tested
 * without ffmpeg. Timing rules:
 * - `d_i = fallbackSlideSec` without clips; with clips
 *   `d_i = max(minSlideSec, clip_i/1000 + padSec + (i === 0 ? 0 : crossfadeSec))`.
 * - `start_0 = 0`; `start_i = start_{i-1} + d_{i-1} - crossfadeSec` (the value `xfade` receives
 *   as `offset`).
 * - `voiceStart_i = start_i + (i === 0 ? 0 : crossfadeSec)` (slide fully visible).
 * - `total = start_last + d_last`.
 * - Words: `startMs + voiceStart_i*1000`, `endMs` clamped to `(start_i + d_i) * 1000`; a word
 *   whose start is past that end is dropped.
 * - With `beatSec` (the music's beat), each voiced slide's end moves up to the next beat, so no
 *   word is cut and every cut lands on the grid even with the crossfade overlap; when that would
 *   push the Reel past `maxTotalSec`, the timeline is built without the grid.
 */
export type ReelClip = Readonly<{ durationMs: number; words: readonly SpokenWord[] }>;

export type ReelSlideTiming = Readonly<{
  index: number;
  /** When this slide starts entering (the xfade offset), seconds. */
  startSec: number;
  /** How long the slide input plays, seconds (what -t receives). */
  durationSec: number;
  /** When its voice clip starts on the final timeline, seconds. */
  voiceStartSec: number;
  /** Words on the final timeline, ms, clamped to this slide's fully-visible window. */
  words: readonly SpokenWord[];
}>;

export type ReelTimeline = Readonly<{
  slides: readonly ReelSlideTiming[];
  totalSec: number;
  crossfadeSec: number;
}>;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export const buildReelTimeline = (
  input: Readonly<{
    slideCount: number;
    clips?: readonly ReelClip[];
    minSlideSec?: number;
    padSec?: number;
    fallbackSlideSec?: number;
    crossfadeSec?: number;
    maxTotalSec?: number;
    beatSec?: number;
  }>,
): ReelTimeline => {
  const {
    slideCount,
    clips,
    minSlideSec = 2.5,
    padSec = 0.5,
    fallbackSlideSec = 4,
    crossfadeSec = 0.8,
    maxTotalSec = 60,
    beatSec,
  } = input;
  const toGrid = (start: number, seconds: number) =>
    beatSec && beatSec > 0
      ? Math.ceil(round3((start + seconds) / beatSec)) * beatSec - start
      : seconds;

  if (!Number.isInteger(slideCount) || slideCount < 1) throw new Error("reel_slide_count_invalid");
  if (clips !== undefined && clips.length !== slideCount)
    throw new Error("reel_clip_count_mismatch");

  const slides: ReelSlideTiming[] = [];
  let start = 0;
  for (let index = 0; index < slideCount; index += 1) {
    const clip = clips?.[index];
    const duration = clip
      ? toGrid(
          start,
          Math.max(minSlideSec, clip.durationMs / 1000 + padSec + (index === 0 ? 0 : crossfadeSec)),
        )
      : fallbackSlideSec;
    const voiceStart = start + (index === 0 ? 0 : crossfadeSec);
    const windowEndMs = (start + duration) * 1000;
    const words = (clip?.words ?? [])
      .map((word) => ({
        text: word.text,
        startMs: word.startMs + voiceStart * 1000,
        endMs: Math.min(word.endMs + voiceStart * 1000, windowEndMs),
      }))
      .filter((word) => word.startMs < windowEndMs);

    slides.push({
      index,
      startSec: round3(start),
      durationSec: round3(duration),
      voiceStartSec: round3(voiceStart),
      words,
    });

    start = start + duration - crossfadeSec;
  }

  const last = slides[slides.length - 1];
  const total = last === undefined ? 0 : last.startSec + last.durationSec;
  if (total > maxTotalSec && beatSec) {
    const { beatSec: _grid, ...plain } = input;
    return buildReelTimeline(plain);
  }
  if (total > maxTotalSec) throw new Error(`reel_too_long:${total.toFixed(1)}`);

  return { slides, totalSec: round3(total), crossfadeSec };
};
