import { describe, expect, it } from "vitest";
import { buildJudgePage } from "./arena.js";
import { MOTION_ARENA, motionSpec } from "./motion-bench.js";

describe("motion bench", () => {
  it("pairs Ken Burns (champion) with 2.5D per scene on a blind video page", () => {
    const spec = motionSpec(["casa_feed", "tech_feed"]);
    expect(spec.champion).toBe("ken_burns");
    expect(spec.media).toEqual({ kind: "video", ext: "mp4" });
    const available = new Set(
      MOTION_ARENA.candidates.flatMap(({ dir }) =>
        ["casa_feed", "tech_feed"].map((c) => `${dir}/${c}.mp4`),
      ),
    );
    const page = buildJudgePage(spec, available, 7);
    expect(page.match(/<video /g)).toHaveLength(8);
    expect(page).not.toMatch(/>\s*(ken_burns|parallax_2_5d|parallax_2_5d_soft)\s*</);
  });
});
