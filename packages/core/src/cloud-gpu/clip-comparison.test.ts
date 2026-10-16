import { describe, expect, it } from "vitest";
import { type ClipRun, renderClipComparison, summarizeClipRuns } from "./clip-comparison.js";

const probe = { durationMs: 5_000, width: 480, height: 832, fps: 16 };
const run = (overrides: Partial<ClipRun>): ClipRun => ({
  caseId: "E",
  candidate: "local-2.5d",
  probe,
  vlmPass: true,
  humanVerdict: "accept",
  costMinor: 0,
  ...overrides,
});

describe("clip comparison", () => {
  it("accepts only human-approved, technically valid clips and prices each accepted clip", () => {
    const runs = [
      run({ caseId: "E" }),
      run({ caseId: "F", humanVerdict: "reject", rejectReason: "face drift" }),
      run({ candidate: "fake-cloud", costMinor: 293 }),
      run({ candidate: "fake-cloud", caseId: "F", costMinor: 293, humanVerdict: "reject" }),
      run({
        candidate: "fake-cloud",
        caseId: "B",
        costMinor: 293,
        probe: { ...probe, durationMs: 3_000 },
      }),
    ];
    const [cloud, local] = summarizeClipRuns(runs);
    expect(cloud).toMatchObject({
      candidate: "fake-cloud",
      attempted: 3,
      accepted: 1,
      technicalFailures: 1,
      vlmPassedHumanRejected: 1,
      totalMinor: 879,
      minorPerAccepted: 879,
    });
    expect(local).toMatchObject({
      accepted: 1,
      totalMinor: 0,
      minorPerAccepted: 0,
      missingCases: ["A", "B", "C", "D"],
    });
  });

  it("prints NOT RUN for missing human verdicts or unknown cost, never an estimate", () => {
    const report = renderClipComparison([
      run({ candidate: "cloud-a", humanVerdict: null, costMinor: null }),
    ]);
    expect(report).toContain("| cloud-a | NOT RUN | 0 / 1 | 0 | 0 | NOT RUN | NOT RUN |");
    expect(renderClipComparison([run({})])).toBe(renderClipComparison([run({})]));
  });
});
