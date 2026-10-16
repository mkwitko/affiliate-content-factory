import { describe, expect, it, vi } from "vitest";
import { pickStrongestHook } from "./hook-pick.js";
import type { DecisionProvider, DecisionRequest } from "./jev-shadow.js";

const scoreProvider = (
  byHook: Readonly<Record<string, { score: number; confidence: number } | Error>>,
): DecisionProvider & { decide: ReturnType<typeof vi.fn> } => ({
  decide: vi.fn(async (request: DecisionRequest) => {
    const answer = byHook[String(request.state.hook)];
    if (!answer) throw new Error("unexpected hook");
    if (answer instanceof Error) throw answer;
    return {
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      answer: {
        type: "score" as const,
        score: answer.score,
        legend: {},
        probabilities: {},
        confidence: answer.confidence,
      },
      usage: { input_tokens: 10, output_tokens: 2 },
      latencyMs: 5,
    };
  }),
});
const input = (hooks: readonly string[]) => ({
  hooks,
  niche: "Casa",
  offerTitle: "Cesto",
  verifiedFacts: [{ key: "current_price", value: { amountMinor: 10000, currency: "BRL" } }],
});

describe("pickStrongestHook", () => {
  it("asks hook_strength per hook with minimal state and picks the highest score", async () => {
    const provider = scoreProvider({
      a: { score: 1.2, confidence: 0.8 },
      b: { score: 2.6, confidence: 0.7 },
      c: { score: 2.1, confidence: 0.9 },
    });
    const pick = await pickStrongestHook(provider, input(["a", "b", "c"]));
    expect(pick).toMatchObject({
      status: "picked",
      chosenIndex: 1,
      scores: [1.2, 2.6, 2.1],
      resolvedModel: "jev-1.13.0",
    });
    expect(provider.decide).toHaveBeenCalledWith({
      name: "hook_strength",
      state: {
        hook: "a",
        niche: "Casa",
        offerTitle: "Cesto",
        verifiedFacts: input([]).verifiedFacts,
      },
    });
  });

  it("keeps the original on a tie", async () => {
    const provider = scoreProvider({
      a: { score: 2, confidence: 0.9 },
      b: { score: 2, confidence: 0.9 },
    });
    expect((await pickStrongestHook(provider, input(["a", "b"]))).chosenIndex).toBe(0);
  });

  it("keeps the original when any call fails or any answer has low confidence", async () => {
    const failing = scoreProvider({
      a: { score: 1, confidence: 0.9 },
      b: new Error("jev_http_529"),
    });
    expect(await pickStrongestHook(failing, input(["a", "b"]))).toMatchObject({
      status: "unavailable",
      chosenIndex: 0,
      scores: [1, null],
    });
    const unsure = scoreProvider({
      a: { score: 1, confidence: 0.9 },
      b: { score: 3, confidence: 0.1 },
    });
    expect(await pickStrongestHook(unsure, input(["a", "b"]))).toMatchObject({
      status: "low_confidence",
      chosenIndex: 0,
    });
  });

  it("never throws, even when the provider throws synchronously", async () => {
    const provider: DecisionProvider = {
      decide: () => {
        throw new Error("boom");
      },
    };
    expect((await pickStrongestHook(provider, input(["a", "b"]))).chosenIndex).toBe(0);
  });
});
