import { describe, expect, it } from "vitest";
import { draftProfile } from "./measure-style-frames.js";

const metrics = {
  frames: 20,
  dominantArea: 0.41,
  secondaryArea: 0.12,
  accentArea: 0.03,
  valueTiers: [0.1, 0.3, 0.6] as const,
  meanChroma: 0.05,
};

describe("draftProfile", () => {
  it("builds a lint-clean draft from measurements and never marks it approved", () => {
    const result = draftProfile(
      {
        id: "expressive-ink-cutout-painted",
        characterStyle: "EXPRESSIVE_INK",
        environmentStyle: "CUTOUT_PAINTED",
        shots: [
          { file: "a.png", halo: { contrast: 0.2, heroAreaPct: 3.1 } },
          { file: "b.png", halo: { contrast: 0.3, heroAreaPct: 7.4 } },
          { file: "c.png" },
        ],
      },
      metrics,
      undefined,
    );
    expect(result.status).toBe("draft_owner_review_pending");
    expect(result.profile).toMatchObject({
      id: "expressive-ink-cutout-painted-draft",
      characterStyle: "EXPRESSIVE_INK",
      environmentStyle: "CUTOUT_PAINTED",
      palette: { areaMax: { dominant: 0.46, secondary: 0.17, accent: 0.08 } },
      value: { areaTarget: [0.1, 0.3, 0.6], minFocalDeltaL: 0.25 },
      composition: { heroAreaPct: [3.1, 7.4] },
    });
    expect(result.measurements.haloContrastMedian).toBe(0.25);
    expect(result.lint).toEqual([]);
  });
});
