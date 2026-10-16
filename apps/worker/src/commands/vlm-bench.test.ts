import { describe, expect, it } from "vitest";
import { summarizeVlmBench, type VlmBenchRun } from "./vlm-bench.js";

const run = (
  file: string,
  expected: VlmBenchRun["expected"],
  a: VlmBenchRun["kinds"][0],
  b: VlmBenchRun["kinds"][1],
  ms = 1000,
): VlmBenchRun => ({ file, expected, latenciesMs: [ms, ms + 200], kinds: [a, b] });

describe("summarizeVlmBench", () => {
  it("computes recall, false reject, agreement and latency", () => {
    const summary = summarizeVlmBench([
      run("bad1.png", ["clutter"], ["clutter"], ["clutter"]),
      run("bad2.png", ["hierarchy"], [], ["hierarchy"]),
      run("ok1.png", [], [], []),
      run("ok2.png", [], ["composition"], null, 3000),
    ]);
    expect(summary).toMatchObject({
      frames: 4,
      invalidReplies: 1,
      recall: 0.5,
      precision: 0.5,
      falseReject: 0.5,
      agreement: 0.5,
      latencyMs: { median: 1200, max: 3200 },
    });
  });

  it("reports null rates for an empty class", () => {
    expect(summarizeVlmBench([run("ok.png", [], [], [])])).toMatchObject({
      recall: null,
      precision: null,
      falseReject: 0,
      agreement: 1,
    });
  });
});
