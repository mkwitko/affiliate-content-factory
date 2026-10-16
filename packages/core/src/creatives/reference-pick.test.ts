import { describe, expect, it } from "vitest";
import { pickReference, referenceScore } from "./reference-pick.js";

const evidence = (over: Partial<Parameters<typeof referenceScore>[0]> = {}) => ({
  sharpness: 300,
  whiteBorderShare: 1,
  width: 1200,
  height: 1200,
  ...over,
});

describe("reference pick", () => {
  it("prefers the sharp, large, clean-background photo over a blurred or busy one", () => {
    expect(referenceScore(evidence())).toBeCloseTo(1, 5);
    expect(referenceScore(evidence({ sharpness: 20 }))).toBeLessThan(referenceScore(evidence()));
    expect(referenceScore(evidence({ whiteBorderShare: 0.1 }))).toBeLessThan(
      referenceScore(evidence()),
    );
    expect(referenceScore(evidence({ width: 300, height: 300 }))).toBeLessThan(
      referenceScore(evidence()),
    );
    expect(
      pickReference([
        { id: "blurry", evidence: evidence({ sharpness: 10 }) },
        { id: "good", evidence: evidence() },
        { id: "busy", evidence: evidence({ whiteBorderShare: 0 }) },
      ]),
    ).toMatchObject({ id: "good" });
  });

  it("keeps listing order on ties and returns null for nothing", () => {
    expect(
      pickReference([
        { id: "first", evidence: evidence() },
        { id: "second", evidence: evidence() },
      ]),
    ).toMatchObject({ id: "first" });
    expect(pickReference([])).toBeNull();
  });
});
