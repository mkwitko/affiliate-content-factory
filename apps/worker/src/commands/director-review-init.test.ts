import { describe, expect, it } from "vitest";
import { reviewSheetFor } from "./director-review-init.js";

const bench = {
  model: "qwen3.8-9b",
  split: "holdout",
  summary: { finalOkRate: 1 },
  gate: { productionScripts: true },
  runs: [{ fixture: { id: "s1", source: "production:s1" } }],
  cases: [{ case_id: "s1", accepted: true, retry_count: 0, validation_failures: [] }],
};

describe("reviewSheetFor", () => {
  it("lists every case with empty human fields and the documented scale", () => {
    const sheet = reviewSheetFor(bench, "director-bench-production/holdout-q.json", new Date(0));
    expect(sheet).toMatchObject({
      benchmark: "director-bench-production/holdout-q.json",
      model: "qwen3.8-9b",
      split: "holdout",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(sheet.scale.product_visibility).toMatch(/n\/a/);
    expect(sheet.cases).toEqual([
      {
        case_id: "s1",
        source: "production:s1",
        accepted: true,
        retry_count: 0,
        validation_failures: [],
        story_coherence: null,
        scene_continuity: null,
        visual_specificity: null,
        product_visibility: null,
        character_consistency: null,
        commercial_intent: null,
        editorial_decision: null,
        manual_fix_minutes: null,
        notes: "",
      },
    ]);
  });

  it("leaves the automatic benchmark untouched", () => {
    const before = structuredClone(bench);
    const sheet = reviewSheetFor(bench, "b.json", new Date(0));
    sheet.cases[0]?.validation_failures.push("changed");
    expect(bench).toEqual(before);
  });
});
