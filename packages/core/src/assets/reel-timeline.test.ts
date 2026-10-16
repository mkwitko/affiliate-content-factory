import { describe, expect, it } from "vitest";
import { buildReelTimeline, type ReelClip } from "./reel-timeline.js";
import type { SpokenWord } from "./speech-synthesizer.js";

const clip = (durationMs: number, words: readonly SpokenWord[] = []): ReelClip => ({
  durationMs,
  words,
});

describe("buildReelTimeline", () => {
  it("holds every slide 4 s without clips and matches today's xfade offsets", () => {
    const t = buildReelTimeline({ slideCount: 3 });
    expect(t.slides.map((s) => s.durationSec)).toEqual([4, 4, 4]);
    expect(t.slides.map((s) => s.startSec)).toEqual([0, 3.2, 6.4]);
    expect(t.totalSec).toBeCloseTo(10.4);
    expect(t.crossfadeSec).toBe(0.8);
  });

  it("stretches a slide to its clip plus pad and crossfade", () => {
    const t = buildReelTimeline({ slideCount: 2, clips: [clip(3000), clip(5000)] });
    expect(t.slides[0]?.durationSec).toBeCloseTo(3.5);
    expect(t.slides[1]?.durationSec).toBeCloseTo(6.3);
    expect(t.slides[1]?.voiceStartSec).toBeCloseTo(3.5 - 0.8 + 0.8);
  });

  it("puts every voiced cut on the music's beat grid without cutting a word", () => {
    // 120 bpm: 0.5 s beats. 3.5 s and 6.3 s round up to 3.5 and 6.5.
    // 100 bpm (0.6 s beats): every slide end lands on the grid despite the 0.8 s overlap.
    const t = buildReelTimeline({
      slideCount: 3,
      clips: [clip(3000), clip(5000), clip(2000)],
      beatSec: 0.6,
    });
    for (const s of t.slides) {
      const end = (s.startSec + s.durationSec) / 0.6;
      expect(Math.abs(end - Math.round(end))).toBeLessThan(0.01);
    }
    // No slide is shorter than its voice needs.
    expect(t.slides[0]?.durationSec).toBeGreaterThanOrEqual(3.5);
    expect(t.slides[1]?.durationSec).toBeGreaterThanOrEqual(6.3);
  });

  it("drops the beat grid rather than failing a Reel the grid would push past the cap", () => {
    const clips = Array.from({ length: 10 }, () => clip(4100));
    const plain = buildReelTimeline({ slideCount: 10, clips, maxTotalSec: 54 });
    const gridded = buildReelTimeline({ slideCount: 10, clips, maxTotalSec: 54, beatSec: 1.5 });
    expect(gridded).toEqual(plain);
  });

  it("never goes under the minimum slide length", () => {
    const t = buildReelTimeline({ slideCount: 1, clips: [clip(500)] });
    expect(t.slides[0]?.durationSec).toBeCloseTo(2.5);
  });

  it("shifts and clamps words to the slide window", () => {
    const t = buildReelTimeline({
      slideCount: 2,
      clips: [
        clip(1000, [{ text: "a", startMs: 0, endMs: 400 }]),
        clip(1000, [{ text: "b", startMs: 100, endMs: 9000 }]),
      ],
    });
    // start_1 = 2.5 - 0.8 = 1.7; d_1 = max(2.5, 1 + 0.5 + 0.8) = 2.5; voiceStart_1 = 1.7 + 0.8 = 2.5
    // word start = 2500 + 100; end clamped to (1.7 + 2.5) * 1000 = 4200
    expect(t.slides[1]?.words[0]).toEqual({ text: "b", startMs: 2600, endMs: 4200 });
  });

  it("fails a 10-slide script whose speech is 58 s in total", () => {
    const clips = Array.from({ length: 10 }, () => clip(5800));
    expect(() => buildReelTimeline({ slideCount: 10, clips })).toThrow(/^reel_too_long:/);
  });

  it("rejects a clip count that differs from the slide count", () => {
    expect(() => buildReelTimeline({ slideCount: 2, clips: [clip(1000)] })).toThrow(
      "reel_clip_count_mismatch",
    );
  });

  it("rejects zero slides", () => {
    expect(() => buildReelTimeline({ slideCount: 0 })).toThrow("reel_slide_count_invalid");
  });
});
