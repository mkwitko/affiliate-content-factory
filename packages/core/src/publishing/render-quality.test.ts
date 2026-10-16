import { describe, expect, it } from "vitest";
import {
  blockingCheckIds,
  countTtsCache,
  evaluateRenderQuality,
  gapsBetween,
  parseRenderQualityReport,
  type RenderExpectations,
  type RenderStats,
  subtractRanges,
  withCacheHits,
  withMusicCheck,
  withNarrationCheck,
} from "./render-quality.js";

const video = { codec: "h264", pixelFormat: "yuv420p", width: 1080, height: 1920, fps: 30 };
const goodStats: RenderStats = {
  readable: true,
  decodeErrors: 0,
  video,
  hasAudio: true,
  durationMs: 30_000,
  integratedLufs: -14,
  truePeakDbtp: -1.6,
  silences: [],
  blacks: [],
  freezes: [],
};
const expected: RenderExpectations = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 30_000,
  audioRequired: true,
  plannedStill: [],
  plannedSilence: [],
  plannedDark: [],
};
const check = (stats: Partial<RenderStats>, expect_: Partial<RenderExpectations>, id: string) =>
  evaluateRenderQuality({ ...goodStats, ...stats }, { ...expected, ...expect_ }).checks.find(
    (entry) => entry.id === id,
  )?.verdict;

describe("evaluateRenderQuality", () => {
  it("passes a render that meets every expectation", () => {
    const report = evaluateRenderQuality(goodStats, expected, new Date("2026-10-01T00:00:00Z"));
    expect(report.verdict).toBe("pass");
    expect(report.version).toBe(1);
    expect(report.measuredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(report.checks.every((entry) => entry.verdict === "pass")).toBe(true);
  });

  it("blocks an unreadable file and marks every other check n/a", () => {
    const report = evaluateRenderQuality(
      { ...goodStats, readable: false, video: undefined, hasAudio: false },
      expected,
    );
    expect(report.verdict).toBe("block");
    expect(blockingCheckIds(report)).toEqual(["container"]);
    expect(report.checks.filter((entry) => entry.id !== "container").map((e) => e.verdict)).toEqual(
      Array(report.checks.length - 1).fill("n/a"),
    );
  });

  it("blocks a wrong codec, pixel format or decode errors", () => {
    expect(check({ video: { ...video, codec: "hevc" } }, {}, "container")).toBe("block");
    expect(check({ video: { ...video, pixelFormat: "yuv444p" } }, {}, "container")).toBe("block");
    expect(check({ decodeErrors: 3 }, {}, "container")).toBe("block");
  });

  it("blocks wrong dimensions and frame rate outside ±0.5", () => {
    expect(check({ video: { ...video, width: 1920 } }, {}, "dimensions")).toBe("block");
    expect(check({ video: { ...video, fps: 29.6 } }, {}, "fps")).toBe("pass");
    expect(check({ video: { ...video, fps: 25 } }, {}, "fps")).toBe("block");
  });

  it("grades duration drift by max(500 ms, 2%) and max(1500 ms, 5%)", () => {
    expect(check({ durationMs: 30_600 }, {}, "duration")).toBe("pass");
    expect(check({ durationMs: 31_400 }, {}, "duration")).toBe("warn");
    expect(check({ durationMs: 32_000 }, {}, "duration")).toBe("block");
    expect(check({ durationMs: 4_600 }, { durationMs: 5_000 }, "duration")).toBe("pass");
    expect(check({ durationMs: 3_400 }, { durationMs: 5_000 }, "duration")).toBe("block");
  });

  it("blocks a missing audio stream only when audio is required", () => {
    expect(check({ hasAudio: false }, {}, "audio_stream")).toBe("block");
    const silent = evaluateRenderQuality(
      { ...goodStats, hasAudio: false, integratedLufs: undefined, truePeakDbtp: undefined },
      { ...expected, audioRequired: false },
    );
    expect(silent.verdict).toBe("pass");
    for (const id of ["loudness", "true_peak", "silence"])
      expect(silent.checks.find((entry) => entry.id === id)?.verdict).toBe("n/a");
  });

  it("grades integrated loudness", () => {
    expect(check({ integratedLufs: -12.5 }, {}, "loudness")).toBe("pass");
    expect(check({ integratedLufs: -18 }, {}, "loudness")).toBe("warn");
    expect(check({ integratedLufs: -10 }, {}, "loudness")).toBe("warn");
    expect(check({ integratedLufs: -35 }, {}, "loudness")).toBe("block");
    expect(check({ integratedLufs: -5 }, {}, "loudness")).toBe("block");
    expect(check({ integratedLufs: -25 }, {}, "loudness")).toBe("warn");
    expect(check({ integratedLufs: undefined }, {}, "loudness")).toBe("n/a");
  });

  it("grades true peak as clipping risk", () => {
    expect(check({ truePeakDbtp: -1 }, {}, "true_peak")).toBe("pass");
    expect(check({ truePeakDbtp: -0.2 }, {}, "true_peak")).toBe("warn");
    expect(check({ truePeakDbtp: 1.2 }, {}, "true_peak")).toBe("block");
  });

  it("ignores planned silence and grades unplanned runs", () => {
    const gap = { startMs: 10_000, endMs: 12_000 };
    expect(check({ silences: [gap] }, { plannedSilence: [gap] }, "silence")).toBe("pass");
    expect(check({ silences: [gap] }, {}, "silence")).toBe("warn");
    expect(check({ silences: [{ startMs: 1_000, endMs: 5_500 }] }, {}, "silence")).toBe("block");
    // Many short unplanned gaps that add up to half the video still block.
    const chopped = Array.from({ length: 15 }, (_, i) => ({
      startMs: i * 2_000,
      endMs: i * 2_000 + 1_000,
    }));
    expect(check({ silences: chopped }, {}, "silence")).toBe("block");
  });

  it("grades black runs and a black first frame", () => {
    expect(check({ blacks: [{ startMs: 5_000, endMs: 5_200 }] }, {}, "black")).toBe("pass");
    expect(check({ blacks: [{ startMs: 5_000, endMs: 5_600 }] }, {}, "black")).toBe("warn");
    expect(check({ blacks: [{ startMs: 0, endMs: 100 }] }, {}, "black")).toBe("warn");
    expect(check({ blacks: [{ startMs: 5_000, endMs: 6_500 }] }, {}, "black")).toBe("block");
    const fade = { startMs: 5_000, endMs: 6_500 };
    expect(check({ blacks: [fade] }, { plannedDark: [fade] }, "black")).toBe("pass");
  });

  it("accepts a planned still of any length and grades unplanned freezes", () => {
    const whole = { startMs: 0, endMs: 30_000 };
    expect(check({ freezes: [whole] }, { plannedStill: [whole] }, "freeze")).toBe("pass");
    expect(check({ freezes: [{ startMs: 3_000, endMs: 6_000 }] }, {}, "freeze")).toBe("warn");
    expect(check({ freezes: [{ startMs: 3_000, endMs: 9_000 }] }, {}, "freeze")).toBe("block");
  });

  it("warns on renderer notes and takes the worst verdict", () => {
    const report = evaluateRenderQuality(
      { ...goodStats, integratedLufs: -18 },
      { ...expected, notes: ["action_dropped:2"] },
    );
    expect(report.verdict).toBe("warn");
    expect(report.checks.find((entry) => entry.id === "render_notes")).toEqual({
      id: "render_notes",
      verdict: "warn",
      detail: "action_dropped:2",
    });
    expect(blockingCheckIds(report)).toEqual([]);
  });
});

describe("subtractRanges", () => {
  it("keeps only the unplanned parts of each detected run", () => {
    expect(
      subtractRanges(
        [
          { startMs: 0, endMs: 10_000 },
          { startMs: 20_000, endMs: 21_000 },
        ],
        [
          { startMs: 2_000, endMs: 4_000 },
          { startMs: 8_000, endMs: 12_000 },
          { startMs: 19_000, endMs: 22_000 },
        ],
      ),
    ).toEqual([
      { startMs: 0, endMs: 2_000 },
      { startMs: 4_000, endMs: 8_000 },
    ]);
  });

  it("gapsBetween returns the uncovered parts of the timeline", () => {
    expect(
      gapsBetween(
        [
          { startMs: 500, endMs: 2_000 },
          { startMs: 1_800, endMs: 3_000 },
          { startMs: 4_000, endMs: 5_000 },
        ],
        6_000,
      ),
    ).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 3_000, endMs: 4_000 },
      { startMs: 5_000, endMs: 6_000 },
    ]);
  });
});

describe("parseRenderQualityReport", () => {
  it("round-trips a stored report and rejects malformed JSON", () => {
    const report = evaluateRenderQuality(goodStats, expected, new Date("2026-10-01T00:00:00Z"));
    expect(parseRenderQualityReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(parseRenderQualityReport(null)).toBeUndefined();
    expect(parseRenderQualityReport({ version: 2, verdict: "pass", checks: [] })).toBeUndefined();
    expect(
      parseRenderQualityReport({ version: 1, verdict: "great", checks: [], measuredAt: "x" }),
    ).toBeUndefined();
    expect(
      parseRenderQualityReport({
        version: 1,
        verdict: "pass",
        checks: [{ id: "fps", verdict: "maybe" }],
        measuredAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("keeps an optional visual section and drops a malformed one", () => {
    const base = {
      version: 1,
      verdict: "pass",
      checks: [],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    const visual = {
      findings: [{ id: "hero_area", severity: "WARN", sceneIndex: 1, detail: "30%" }],
      colorStrip: ["#808080"],
    };
    expect(parseRenderQualityReport({ ...base, visual })?.visual).toEqual(visual);
    expect(parseRenderQualityReport(base)?.visual).toBeUndefined();
    expect(
      parseRenderQualityReport({ ...base, visual: { findings: [{ id: 3 }], colorStrip: [] } })
        ?.visual,
    ).toBeUndefined();
  });
});

describe("cache counters", () => {
  it("counts only results that carry a cached flag", () => {
    expect(countTtsCache([{ cached: true }, { cached: false }, {}])).toEqual({
      tts: { hit: 1, miss: 1 },
    });
    expect(countTtsCache([{}, {}])).toEqual({});
  });
  it("attaches counters to a report and leaves undefined alone", () => {
    const report = { version: 1 as const, verdict: "pass" as const, checks: [], measuredAt: "t" };
    expect(withCacheHits(report, { tts: { hit: 2, miss: 0 } })).toEqual({
      ...report,
      cacheHits: { tts: { hit: 2, miss: 0 } },
    });
    expect(withCacheHits(report, {})).toBe(report);
    expect(withCacheHits(undefined, { tts: { hit: 1, miss: 0 } })).toBeUndefined();
  });
  it("keeps valid cache counters through the stored-report parser and drops malformed ones", () => {
    const stored = {
      version: 1,
      verdict: "pass",
      checks: [],
      measuredAt: "t",
      cacheHits: { tts: { hit: 3, miss: 1 }, junk: { hit: "x" } },
    };
    expect(parseRenderQualityReport(stored)?.cacheHits).toEqual({ tts: { hit: 3, miss: 1 } });
    expect(parseRenderQualityReport({ ...stored, cacheHits: 5 })?.cacheHits).toBeUndefined();
  });
});

describe("withMusicCheck", () => {
  const report = { version: 1 as const, verdict: "pass" as const, checks: [], measuredAt: "t" };
  it("warns a music-less Reel, passes one with a track, never blocks, and is idempotent", () => {
    const silent = withMusicCheck(report, false);
    expect(silent?.verdict).toBe("warn");
    expect(silent?.checks).toEqual([expect.objectContaining({ id: "music", verdict: "warn" })]);
    expect(withMusicCheck(silent, true)).toBe(silent);
    expect(withMusicCheck(report, true)).toEqual({
      ...report,
      checks: [{ id: "music", verdict: "pass" }],
    });
    const blocked = { ...report, verdict: "block" as const };
    expect(withMusicCheck(blocked, false)?.verdict).toBe("block");
    expect(withMusicCheck(undefined, false)).toBeUndefined();
    expect(parseRenderQualityReport(JSON.parse(JSON.stringify(silent)))).toEqual(silent);
  });
  it("warns a track whose licence is not in the manifest, passes a recorded one", () => {
    expect(withMusicCheck(report, {})?.checks).toEqual([
      { id: "music", verdict: "warn", detail: "music licence not recorded in the manifest" },
    ]);
    expect(withMusicCheck(report, { license: "CC0" })?.verdict).toBe("pass");
  });
});

describe("withNarrationCheck", () => {
  const base = evaluateRenderQuality(goodStats, expected, new Date("2026-10-01T00:00:00Z"));
  const narration = (verdict: "pass" | "block") => ({
    verdict,
    wer: 0.1,
    missing: verdict === "block" ? ["R$ 329,90"] : [],
    model: "local:parakeet-tdt-0.6b-v3",
    checkedAt: "2026-10-01T00:01:00.000Z",
  });

  it("blocks the report on a number mismatch and survives a storage round trip", () => {
    const blocked = withNarrationCheck(base, narration("block"));
    expect(blocked.verdict).toBe("block");
    expect(parseRenderQualityReport(JSON.parse(JSON.stringify(blocked)))).toEqual(blocked);
  });

  it("keeps the verdict when the narration passes", () => {
    expect(withNarrationCheck(base, narration("pass")).verdict).toBe("pass");
  });
});
