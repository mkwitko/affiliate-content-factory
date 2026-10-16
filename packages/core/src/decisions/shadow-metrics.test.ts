import { describe, expect, it } from "vitest";
import { shadowAgreement } from "./shadow-metrics.js";

describe("shadowAgreement", () => {
  it("scores an advisor against the human decision and counts both error kinds", () => {
    const m = shadowAgreement([
      { advisor: "reject", rules: "reject", human: "reject", confidence: 0.9 },
      { advisor: "accept", rules: "accept", human: "reject", confidence: 0.8 },
      { advisor: "reject", rules: "accept", human: "accept", confidence: 0.6 },
      { advisor: "accept", rules: "accept", human: "accept", confidence: 0.7 },
      { advisor: null, rules: "accept", human: "accept" },
      { advisor: "accept", rules: "accept", human: null },
    ]);
    expect(m).toMatchObject({
      labelled: 5,
      answered: 4,
      advisorAgreement: 0.5,
      rulesAgreement: 0.8,
      falseAccept: 1,
      falseReject: 1,
      rejectPrecision: 0.5,
      rejectRecall: 0.5,
    });
    // |0.9-1| + |0.8-0| + |0.6-0| + |0.7-1| over 4 = (0.1+0.8+0.6+0.3)/4
    expect(m.calibrationError).toBeCloseTo(0.45, 5);
  });

  it("reports nulls instead of rates when nothing is labelled", () => {
    expect(shadowAgreement([{ advisor: "accept", rules: "accept", human: null }])).toMatchObject({
      labelled: 0,
      advisorAgreement: null,
      rejectPrecision: null,
    });
  });
});
