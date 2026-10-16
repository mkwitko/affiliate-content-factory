import { describe, expect, it } from "vitest";
import { buildArenaReport, renderArenaMarkdown } from "./report.js";

const FLUX = "local:flux-2-klein-4b";
const LONGCAT = "local:longcat-image-edit-turbo";
const stages = { smoke: "pass", qualification: "pass", full: "pass" } as const;
const metric = (latencyP95Ms: number) => ({
  stages,
  latencyP95Ms,
  failureRate: 0,
  peakVramMb: 7_000,
  criticalRegressions: [],
});

describe("buildArenaReport", () => {
  it("ranks, separates criteria and proposes from human labels when there are enough", () => {
    const judgments = Array.from({ length: 20 }, (_, i) => [
      { caseId: `c${i}`, left: FLUX, right: LONGCAT, winner: "right" as const, judge: "human" },
      { caseId: `c${i}`, left: LONGCAT, right: FLUX, winner: "left" as const, judge: "human" },
      {
        caseId: `c${i}#productFidelity`,
        left: FLUX,
        right: LONGCAT,
        winner: "left" as const,
        judge: "vlm:qwen3-vl-4b",
      },
    ]).flat();
    const report = buildArenaReport({
      task: "image.character_scene",
      champion: FLUX,
      candidates: [FLUX, LONGCAT],
      judgments,
      metrics: { [FLUX]: metric(200_000), [LONGCAT]: metric(220_000) },
    });
    expect(report.overall.all?.[0]?.id).toBe(LONGCAT);
    expect(report.criteria.productFidelity?.[0]?.id).toBe(FLUX);
    expect(report.positionBiasRate).toBe(0);
    expect(report.proposals[0]).toMatchObject({ recommendation: "promote", winRate: 1 });
    expect(report.proposals[0]?.notes).toContain("decided_on_human_labels");
    expect(renderArenaMarkdown(report)).toContain("**promote**");
  });

  it("makes no proposal without champion metrics", () => {
    const report = buildArenaReport({
      task: "t",
      champion: FLUX,
      candidates: [FLUX, LONGCAT],
      judgments: [],
      metrics: {},
    });
    expect(report.proposals).toEqual([]);
    expect(report.pareto.incomplete).toEqual([FLUX, LONGCAT]);
  });
});
