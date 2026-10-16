import { describe, expect, it } from "vitest";
import {
  judgeFidelity,
  PROVISIONAL_FIDELITY_THRESHOLDS,
  UNMEASURED_FIDELITY,
  worstFidelityVerdict,
  type FidelityMetrics,
  type FidelityThresholds,
} from "./product-fidelity.js";

const clean: FidelityMetrics = {
  maskIou: 0.99,
  deltaE: 0.6,
  msSsim: 0.99,
  edgeRecall: 0.99,
  edgeExcess: 0.01,
  inventedText: [],
};
const strict: FidelityThresholds = {
  id: "test-strict",
  block: { maskIouBelow: 0.95, deltaEAbove: 1, edgeRecallBelow: 0.95 },
  warn: {
    maskIouBelow: 0.999,
    deltaEAbove: 0.5,
    msSsimBelow: 0.999,
    edgeRecallBelow: 0.999,
    edgeExcessAbove: 0,
  },
};

describe("judgeFidelity", () => {
  it("passes clean metrics and records which threshold set judged them", () => {
    expect(judgeFidelity(clean, PROVISIONAL_FIDELITY_THRESHOLDS)).toMatchObject({
      ...clean,
      verdict: "pass",
      reasons: [],
      thresholdSet: "provisional-2026-09-30",
    });
  });

  it("blocks a changed silhouette, a wrong colour, lost detail or invented text", () => {
    const t = PROVISIONAL_FIDELITY_THRESHOLDS;
    expect(judgeFidelity({ ...clean, maskIou: 0.5 }, t)).toMatchObject({
      verdict: "block",
      reasons: ["maskIou_block"],
    });
    expect(judgeFidelity({ ...clean, deltaE: 30 }, t).reasons).toEqual(["deltaE_block"]);
    expect(judgeFidelity({ ...clean, edgeRecall: 0.3 }, t).reasons).toEqual(["edgeRecall_block"]);
    expect(judgeFidelity({ ...clean, inventedText: ["promo"] }, t)).toMatchObject({
      verdict: "block",
      reasons: ["invented_text"],
      inventedText: ["promo"],
    });
  });

  it("warns between the warn and block limits and lists blocks before warns", () => {
    const report = judgeFidelity(
      { ...clean, maskIou: 0.5, msSsim: 0.8, edgeExcess: 0.5 },
      PROVISIONAL_FIDELITY_THRESHOLDS,
    );
    expect(report.verdict).toBe("block");
    expect(report.reasons).toEqual(["maskIou_block", "msSsim_warn", "edgeExcess_warn"]);
    expect(judgeFidelity({ ...clean, deltaE: 8 }, PROVISIONAL_FIDELITY_THRESHOLDS)).toMatchObject({
      verdict: "warn",
      reasons: ["deltaE_warn"],
    });
  });

  it("routes unmeasured or non-finite metrics to review, never pass or block", () => {
    const report = judgeFidelity(UNMEASURED_FIDELITY, PROVISIONAL_FIDELITY_THRESHOLDS);
    expect(report.verdict).toBe("warn");
    expect(report.reasons).toEqual([
      "maskIou_unmeasured",
      "deltaE_unmeasured",
      "msSsim_unmeasured",
      "edgeRecall_unmeasured",
      "edgeExcess_unmeasured",
    ]);
    expect(
      judgeFidelity({ ...clean, deltaE: Number.NaN }, PROVISIONAL_FIDELITY_THRESHOLDS),
    ).toMatchObject({
      verdict: "warn",
      reasons: ["deltaE_unmeasured"],
    });
  });

  it("uses the injected thresholds, not built-in numbers", () => {
    expect(judgeFidelity(clean, strict)).toMatchObject({
      verdict: "warn",
      thresholdSet: "test-strict",
    });
    expect(judgeFidelity({ ...clean, deltaE: 2 }, strict).verdict).toBe("block");
  });
});

describe("worstFidelityVerdict", () => {
  it("returns the most severe verdict and pass for an empty list", () => {
    expect(worstFidelityVerdict([])).toBe("pass");
    expect(worstFidelityVerdict(["pass", "warn", "pass"])).toBe("warn");
    expect(worstFidelityVerdict(["warn", "block", "pass"])).toBe("block");
  });
});
