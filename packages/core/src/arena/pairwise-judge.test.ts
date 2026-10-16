import { describe, expect, it } from "vitest";
import {
  judgmentsFromAnswer,
  PAIRWISE_CRITERIA,
  pairwiseJudgePrompt,
  parsePairwiseJudgeAnswer,
} from "./pairwise-judge.js";
import { reconcileJudgments } from "./ranking.js";

const all = (v: "A" | "B" | "TIE") =>
  Object.fromEntries([...PAIRWISE_CRITERIA, "overallWinner"].map((k) => [k, v]));

describe("pairwise judge", () => {
  it("rejects an answer with a missing or invalid criterion", () => {
    expect(parsePairwiseJudgeAnswer({ ...all("A"), composition: "C" })).toBeNull();
    const { overallWinner: _, ...partial } = all("A");
    expect(parsePairwiseJudgeAnswer(partial)).toBeNull();
    expect(parsePairwiseJudgeAnswer("A")).toBeNull();
  });

  it("maps A/B to display slots so swapped-order runs reconcile", () => {
    const first = parsePairwiseJudgeAnswer(all("B"));
    const swapped = parsePairwiseJudgeAnswer(all("A"));
    if (!first || !swapped) throw new Error("parse failed");
    const judgments = [
      ...judgmentsFromAnswer({ caseId: "c1", left: "flux", right: "mage", judge: "vlm:q" }, first),
      ...judgmentsFromAnswer(
        { caseId: "c1", left: "mage", right: "flux", judge: "vlm:q" },
        swapped,
      ),
    ];
    const outcomes = reconcileJudgments(judgments);
    expect(outcomes).toHaveLength(PAIRWISE_CRITERIA.length + 1);
    expect(outcomes.every((o) => o.result === "b" && !o.positionBias)).toBe(true);
    expect(outcomes.map((o) => o.caseId)).toContain("c1#productFidelity");
  });

  it("names references before the candidates and never the models", () => {
    const prompt = pairwiseJudgePrompt({ brief: "Bia na pia", references: ["product"] });
    expect(prompt).toMatch(/^The first 1 image\(s\) are references: product\./);
    expect(prompt).not.toMatch(/flux|mage-flow|klein/i);
  });
});
