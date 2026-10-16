import { describe, expect, it, vi } from "vitest";
import { JEV_QUESTIONS, evaluateJevShadow } from "./jev-shadow.js";

describe("Jev shadow decisions", () => {
  it("uses a closed, versioned catalog with no factual or publication authority", () => {
    expect(Object.keys(JEV_QUESTIONS)).toEqual([
      "creative_format",
      "generation_route",
      "hook_strength",
      "commercial_strength",
      "claim_risk",
      "should_regenerate",
      "should_escalate",
    ]);
    expect(JEV_QUESTIONS.generation_route.criteria).toHaveProperty("LOCAL_I2V");
    expect(JEV_QUESTIONS).not.toHaveProperty("publication_authorized");
  });

  it("records advice while returning the deterministic route even on provider failure", async () => {
    const record = vi.fn(async () => undefined);
    const current = "STICKMAN";
    const result = await evaluateJevShadow(
      {
        decide: async () => ({
          requestedModel: "jev-latest",
          resolvedModel: "jev-1",
          answer: {
            type: "choice",
            choice: "LOCAL_I2V",
            probabilities: { LOCAL_I2V: 1 },
            confidence: 1,
          },
          usage: { input_tokens: 3, output_tokens: 2 },
          latencyMs: 7,
        }),
      },
      {
        name: "generation_route",
        state: { renderer: "stickman_motion" },
        existingChoice: current,
        validatorResult: "pass",
        finalAcceptedRoute: current,
      },
      record,
    );
    expect(result).toBe(current);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "generation_route",
        schemaVersion: 1,
        existingChoice: current,
        finalAcceptedRoute: current,
        answer: expect.objectContaining({ choice: "LOCAL_I2V" }),
      }),
    );
    record.mockClear();
    expect(
      await evaluateJevShadow(
        {
          decide: async () => {
            throw new Error("secret provider failure");
          },
        },
        {
          name: "generation_route",
          state: {},
          existingChoice: current,
          validatorResult: "pass",
          finalAcceptedRoute: current,
        },
        record,
      ),
    ).toBe(current);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unavailable", finalAcceptedRoute: current }),
    );
  });
});
