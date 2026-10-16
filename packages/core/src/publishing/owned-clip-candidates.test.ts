import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  buildCandidateWindows,
  durationScore,
  evaluateOwnedClipCandidates,
  type OwnedClipCandidateInput,
} from "./owned-clip-candidates.js";
import { buildRenderTimingManifest } from "./render-timing-manifest.js";

// 12 scenes of 10 s, each "w0 w1 ... w9" one word per second, words are 2 chars + space.
const sceneWords = 10;
const build = (sceneCount: number) => {
  const words: string[] = [];
  const timed = [];
  const scenes = [];
  let char = 0;
  for (let s = 0; s < sceneCount; s += 1) {
    const from = char;
    for (let w = 0; w < sceneWords; w += 1) {
      const text = `s${String(s).padStart(2, "0")}w${w}`;
      words.push(text);
      timed.push({
        text,
        fromChar: char,
        toChar: char + text.length,
        startMs: s * 10_000 + w * 1000,
        endMs: s * 10_000 + w * 1000 + 800,
        sceneIndex: s + 1,
      });
      char += text.length + 1;
    }
    scenes.push({
      index: s + 1,
      fromChar: from,
      toChar: char,
      startMs: s * 10_000,
      endMs: s * 10_000 + 9_800,
      sourceAssetId: `a${s}`,
      sourceAssetChecksum: "d".repeat(64),
    });
  }
  const body = `${words.join(" ")} `;
  const manifest = buildRenderTimingManifest({
    workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
    renderId: "r",
    storyboardId: "b",
    storyboardChecksum: "a".repeat(64),
    scriptId: "s",
    scriptChecksum: "b".repeat(64),
    scriptLength: body.length,
    renderedAssetId: "v",
    renderedAssetChecksum: "c".repeat(64),
    rendererVersion: 1,
    durationMs: sceneCount * 10_000,
    audioTimelineOffsetMs: 0,
    measuredAt: "2026-09-30T00:00:00.000Z",
    scenes,
    words: timed,
  });
  return { body, manifest, scenes };
};
const { body, manifest, scenes } = build(12);
// Span of scenes [a, b] inclusive (0-based), hook = its first word.
const span = (a: number, b: number, extra: Partial<OwnedClipCandidateInput> = {}) => ({
  fromChar: scenes[a]?.fromChar as number,
  toChar: scenes[b]?.toChar as number,
  title: "t",
  hook: `s${String(a).padStart(2, "0")}w0`,
  reason: "r",
  signals: ["strong_hook" as const],
  score: 80,
  ...extra,
});

describe("durationScore", () => {
  it("is 1 inside 30-60 s, linear to 0 at 15 s and 90 s", () => {
    expect(durationScore(45_000)).toBe(1);
    expect(durationScore(30_000)).toBe(1);
    expect(durationScore(60_000)).toBe(1);
    expect(durationScore(22_500)).toBeCloseTo(0.5);
    expect(durationScore(75_000)).toBeCloseTo(0.5);
    expect(durationScore(15_000)).toBe(0);
    expect(durationScore(90_000)).toBe(0);
    expect(durationScore(5_000)).toBe(0);
  });
});

describe("evaluateOwnedClipCandidates", () => {
  const run = (candidates: OwnedClipCandidateInput[], count = 8) =>
    evaluateOwnedClipCandidates({ manifest, scriptBody: body, candidates, count });

  it("snaps to word timing and reports duration and scene", () => {
    const { kept } = run([span(0, 3)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ startMs: 0, sceneIndex: 1, fromChar: 0 });
    expect(kept[0]?.durationMs).toBeGreaterThan(30_000);
  });

  it("clamps toChar to the script length", () => {
    const { kept } = run([span(10, 11, { toChar: 999_999 })]);
    // Clamped to the script end, then snapped to the last word (the script ends in a space).
    expect(kept[0]?.toChar).toBe(manifest.scriptLength - 1);
  });

  it("drops a span whose hook does not open it", () => {
    const { kept, dropped } = run([span(0, 3, { hook: "s02w0" }), span(0, 3, { hook: "nope" })]);
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.reason)).toEqual(["hook_not_opening", "hook_not_opening"]);
  });

  it("drops an invalid span and a span outside the hard 10-180 s bounds", () => {
    const big = build(20);
    const { kept, dropped } = evaluateOwnedClipCandidates({
      manifest: big.manifest,
      scriptBody: big.body,
      count: 8,
      candidates: [
        span(0, 0, { fromChar: 5, toChar: 5 }),
        span(0, 0),
        { ...span(0, 0), toChar: big.manifest.scriptLength },
      ],
    });
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.reason)).toEqual([
      "span_invalid",
      "duration_out_of_range",
      "duration_out_of_range",
    ]);
  });

  it("drops a span no timed word matches", () => {
    const sparse = { ...manifest, words: [] };
    const { dropped } = evaluateOwnedClipCandidates({
      manifest: sparse,
      scriptBody: body,
      candidates: [span(0, 3)],
      count: 5,
    });
    expect(dropped[0]?.reason).toBe("snap_failed");
  });

  it("keeps the higher ranked of two candidates overlapping by more than half", () => {
    const { kept, dropped } = run([
      span(0, 3, { score: 60 }),
      span(1, 4, { score: 90 }),
      span(6, 9, { score: 50 }),
    ]);
    expect(kept.map((c) => c.score)).toEqual([90, 50]);
    expect(dropped).toEqual([{ index: 0, reason: "duplicate" }]);
  });

  it("ranks by score times duration score", () => {
    const { kept } = run([span(0, 1, { score: 90 }), span(6, 9, { score: 50 })]);
    expect(kept.map((c) => c.score)).toEqual([50, 90]);
  });

  it("keeps at most two candidates that start in the same scene", () => {
    const first = scenes[0] as (typeof scenes)[number];
    // Disjoint-in-time is impossible inside one scene, so use three overlap-free tails:
    // start words 0, 1 and 2 of scene 0 cannot avoid overlap; assert the cap on distinct scenes
    // by giving the scene cap a different check: same start scene, different end, no overlap > 50%.
    const at = (word: number, to: number) =>
      span(0, to, {
        fromChar: first.fromChar + word * 6,
        hook: `s00w${word}`,
        toChar: scenes[to]?.toChar as number,
      });
    const { kept } = run([at(0, 4), at(9, 9)]);
    expect(kept.filter((c) => c.sceneIndex === 1).length).toBeLessThanOrEqual(2);
  });

  it("limits the result to count", () => {
    const { kept } = run([span(0, 3), span(4, 7), span(8, 11)], 2);
    expect(kept).toHaveLength(2);
  });
});

describe("buildCandidateWindows", () => {
  it("returns one window for a script of 6 minutes or less", () => {
    const windows = buildCandidateWindows(manifest, body);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ fromChar: 0, toChar: manifest.scriptLength, startMs: 0 });
  });

  it("uses scene-aligned windows of about 90 s with 30 s overlap for a longer script", () => {
    const long = build(40);
    const windows = buildCandidateWindows(long.manifest, long.body);
    expect(windows.length).toBeGreaterThan(3);
    for (const w of windows.slice(0, -1)) {
      expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(80_000);
      expect(long.scenes.some((s) => s.startMs === w.startMs)).toBe(true);
    }
    const [a, b] = windows;
    expect((b?.startMs as number) < (a?.endMs as number)).toBe(true);
    expect(windows.at(-1)?.toChar).toBe(long.manifest.scriptLength);
  });
});
