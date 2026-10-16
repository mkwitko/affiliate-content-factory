import { describe, expect, it } from "vitest";
import { directQuality } from "./quality-director.js";

describe("directQuality", () => {
  it("passes a clean package on every dimension", () => {
    const out = directQuality({
      render: { state: "rendered", fidelity: "pass", quality: "pass", sequence: [] },
      reel: { checks: [{ id: "music", verdict: "pass" }] },
    });
    expect(out).toEqual({
      level: "PASS",
      dimensions: {
        product: "PASS",
        legibility: "PASS",
        sequence: "PASS",
        audio: "PASS",
        render: "PASS",
      },
      findings: [],
    });
  });

  it("grades each dimension, worst first, with the repair each finding calls for", () => {
    const out = directQuality({
      render: {
        state: "rendered",
        reason: "in_scene_partial:3:feed:attempts_exhausted:product_differs_from_reference",
        fidelity: "review",
        quality: "warn",
        sequence: ["duplicate_scene:2,3", "cta_not_last:4"],
      },
      reel: {
        checks: [
          { id: "music", verdict: "warn", detail: "music licence not recorded in the manifest" },
          { id: "loudness", verdict: "warn", detail: "-9 LUFS" },
        ],
        narration: "block",
      },
    });
    expect(out.level).toBe("BLOCK");
    expect(out.dimensions).toEqual({
      product: "REVIEW",
      legibility: "WARN",
      sequence: "BLOCK",
      audio: "BLOCK",
      render: "PASS",
    });
    expect(out.findings[0]?.level).toBe("BLOCK");
    expect(out.findings.map((f) => [f.reason.split(":")[0], f.repair])).toEqual(
      expect.arrayContaining([
        ["in_scene_partial", "composite_product"],
        ["fidelity_review", "owner_review"],
        ["slide_quality_warn", "relayout_text"],
        ["duplicate_scene", "redraw_duplicate_scene"],
        ["cta_not_last", "reorder_slides"],
        ["music", "record_music_licence"],
        ["loudness", "owner_review"],
        ["narration_block", "regenerate_voice"],
      ]),
    );
  });

  it("blocks a failed render for the owner and redraws an exhausted slot that was not the product", () => {
    expect(
      directQuality({ render: { state: "failed", reason: "renderer_down" } }).findings,
    ).toEqual([
      { dimension: "render", level: "BLOCK", reason: "renderer_down", repair: "owner_review" },
    ]);
    expect(
      directQuality({
        render: {
          state: "rendered",
          reason: "in_scene_partial:2:feed:attempts_exhausted:extra_person",
        },
      }).findings[0]?.repair,
    ).toBe("redraw_scene");
  });
});
