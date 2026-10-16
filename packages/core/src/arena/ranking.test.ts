import { describe, expect, it } from "vitest";
import { bradleyTerry, headToHead, reconcileJudgments } from "./ranking.js";

const judge = (
  caseId: string,
  left: string,
  right: string,
  winner: "left" | "right" | "tie" | "reject_both",
) => ({ caseId, left, right, winner, judge: "human" as const });

describe("reconcileJudgments", () => {
  it("keeps a verdict that survives the swapped order", () => {
    const outcomes = reconcileJudgments([
      judge("c1", "flux", "longcat", "right"),
      judge("c1", "longcat", "flux", "left"),
    ]);
    expect(outcomes).toEqual([
      { caseId: "c1", judge: "human", a: "flux", b: "longcat", result: "b", positionBias: false },
    ]);
  });

  it("turns a verdict that follows the display slot into a biased tie", () => {
    const outcomes = reconcileJudgments([
      judge("c1", "flux", "longcat", "left"),
      judge("c1", "longcat", "flux", "left"),
    ]);
    expect(outcomes[0]).toMatchObject({ result: "tie", positionBias: true });
  });

  it("accepts a single-order judgment without a bias claim", () => {
    const outcomes = reconcileJudgments([judge("c2", "flux", "zimage", "reject_both")]);
    expect(outcomes[0]).toMatchObject({ a: "flux", b: "zimage", result: "reject_both" });
    expect(outcomes[0]?.positionBias).toBe(false);
  });
});

describe("bradleyTerry", () => {
  it("ranks a model that wins most comparisons first and stays finite on a clean sweep", () => {
    const outcomes = reconcileJudgments([
      judge("c1", "a", "b", "left"),
      judge("c2", "a", "b", "left"),
      judge("c3", "a", "c", "left"),
      judge("c4", "b", "c", "left"),
      judge("c5", "b", "c", "tie"),
    ]);
    const ranking = bradleyTerry(outcomes);
    expect(ranking.map((r) => r.id)).toEqual(["a", "b", "c"]);
    for (const r of ranking) expect(Number.isFinite(r.score)).toBe(true);
    expect(ranking.find((r) => r.id === "a")).toMatchObject({ wins: 3, losses: 0, comparisons: 3 });
  });

  it("counts reject_both against both models without ranking it", () => {
    const ranking = bradleyTerry(reconcileJudgments([judge("c1", "a", "b", "reject_both")]));
    expect(ranking.find((r) => r.id === "a")).toMatchObject({ rejected: 1, comparisons: 0 });
  });
});

describe("headToHead", () => {
  it("counts ties as half a win", () => {
    const outcomes = reconcileJudgments([
      judge("c1", "champ", "chal", "right"),
      judge("c2", "champ", "chal", "tie"),
      judge("c3", "chal", "champ", "right"),
    ]);
    expect(headToHead(outcomes, "chal", "champ")).toEqual({ comparisons: 3, winRate: 0.5 });
  });
});
