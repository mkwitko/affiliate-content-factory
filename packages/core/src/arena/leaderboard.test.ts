import { describe, expect, it } from "vitest";
import {
  buildLeaderboard,
  type CandidateResult,
  renderLeaderboardMarkdown,
} from "./leaderboard.js";

const result = (
  id: string,
  cers: readonly number[],
  over: Partial<CandidateResult> = {},
): CandidateResult => ({
  id,
  status: "ok",
  stage: "full",
  cases: cers.map((cer, i) => ({ caseId: `c${i}`, metrics: { cer } })),
  aggregate: {
    cer: cers.reduce((s, v) => s + v, 0) / cers.length,
    failureRate: 0,
    clippingRatio: 0,
  },
  latencyP95Ms: 1000,
  failureRate: 0,
  peakVramMb: null,
  ...over,
});

const many = (v: number) => Array.from({ length: 20 }, () => v);

describe("buildLeaderboard", () => {
  it("ranks by the primary metric and proposes a clearly better challenger", () => {
    const board = buildLeaderboard(
      "tts.ptbr",
      [
        result("local:kokoro#pf_dora", many(0.05)),
        result("local:voxcpm2", many(0.01)),
        result("local:supertonic-3", [], { status: "RUNTIME_BLOCKED", error: "load_failed" }),
      ],
      "local:kokoro#pf_dora",
    );
    expect(board.rows.map((r) => [r.rank, r.id])).toEqual([
      [1, "local:voxcpm2"],
      [2, "local:kokoro#pf_dora"],
      [null, "local:supertonic-3"],
    ]);
    expect(board.rows[0]?.headToHead).toEqual({ comparisons: 20, winRate: 1 });
    expect(board.proposals[0]).toMatchObject({
      challenger: "local:voxcpm2",
      recommendation: "promote",
    });
    expect(board.rows[2]?.gatesFailed).toEqual(["RUNTIME_BLOCKED"]);
    expect(renderLeaderboardMarkdown(board)).toContain("| 1 | local:voxcpm2 | ok |");
  });

  it("keeps the champion when a challenger fails a hard gate or only ran the smoke stage", () => {
    const board = buildLeaderboard(
      "tts.ptbr",
      [
        result("local:kokoro#pf_dora", many(0.05)),
        result("local:qwen3-tts", many(0.01), {
          aggregate: { cer: 0.01, failureRate: 0, clippingRatio: 0.02 },
        }),
        result("local:magpie-tts", many(0.01), { stage: "smoke" }),
      ],
      "local:kokoro#pf_dora",
    );
    const byId = Object.fromEntries(board.proposals.map((p) => [p.challenger, p]));
    expect(byId["local:qwen3-tts"]?.recommendation).toBe("keep");
    expect(byId["local:qwen3-tts"]?.reasons).toContain("critical_regression:no clipping");
    expect(byId["local:magpie-tts"]?.reasons).toContain("stage_full_not_run");
  });

  it("treats differences below the task's epsilon as ties", () => {
    const board = buildLeaderboard(
      "tts.ptbr",
      [result("local:kokoro#pf_dora", many(0.05)), result("local:voxcpm2", many(0.052))],
      "local:kokoro#pf_dora",
    );
    expect(board.rows.find((r) => r.id === "local:voxcpm2")?.headToHead?.winRate).toBe(0.5);
  });
});
