import { describe, expect, it } from "vitest";
import { judgeCutout, judgeSegmentation } from "./cutout-qa.js";

const good = {
  coverage: 0.4,
  margin: 0.05,
  components: 1,
  largestRatio: 1,
  whiteness: 1,
  contrast: 120,
};

describe("judgeCutout", () => {
  it("accepts a clean mask", () => expect(judgeCutout(good)).toEqual({ ok: true }));
  it("rejects a low-contrast mask before coverage", () =>
    expect(judgeCutout({ ...good, coverage: 0, contrast: 8 })).toEqual({
      ok: false,
      reason: "low_contrast",
    }));
  it("rejects a mask touching the frame", () =>
    expect(judgeCutout({ ...good, margin: 0 })).toEqual({ ok: false, reason: "touches_edge" }));
  it("rejects fragments", () =>
    expect(judgeCutout({ ...good, components: 40, largestRatio: 0.5 })).toEqual({
      ok: false,
      reason: "fragmented",
    }));
  it("rejects a non-white background", () =>
    expect(judgeCutout({ ...good, whiteness: 0.2 })).toEqual({
      ok: false,
      reason: "background_not_white",
    }));
  it("rejects coverage outside the calibrated range", () => {
    expect(judgeCutout({ ...good, coverage: 0.01 })).toEqual({ ok: false, reason: "coverage_low" });
    expect(judgeCutout({ ...good, coverage: 0.8 })).toEqual({ ok: false, reason: "coverage_high" });
  });
});

describe("judgeSegmentation", () => {
  const segmented = { ...good, whiteness: 0.05, contrast: 3 };
  it("accepts a confident mask on a non-white background", () =>
    expect(judgeSegmentation(segmented, 0.95, 0.9)).toEqual({ ok: true }));
  it("rejects low or non-finite confidence before geometry", () => {
    expect(judgeSegmentation({ ...segmented, margin: 0 }, 0.5, 0.9)).toEqual({
      ok: false,
      reason: "low_confidence",
    });
    expect(judgeSegmentation(segmented, Number.NaN, 0.9)).toEqual({
      ok: false,
      reason: "low_confidence",
    });
  });
  it("still applies the geometry checks", () =>
    expect(judgeSegmentation({ ...segmented, coverage: 0.9 }, 0.95, 0.9)).toEqual({
      ok: false,
      reason: "coverage_high",
    }));
});
