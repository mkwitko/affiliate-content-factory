import { describe, expect, it, vi } from "vitest";
import { createJevDecisionProvider } from "./jev-decision-provider.js";

describe("TypeSafe System One adapter", () => {
  it("sends one closed question and parses the resolved model and usage", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        model: "jev-1.13.0",
        answers: {
          generation_route: {
            type: "choice",
            choice: "STICKMAN",
            probabilities: { STICKMAN: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    );
    const provider = createJevDecisionProvider({
      apiKey: "secret-key",
      model: "jev-latest",
      fetch: fetcher,
    });
    const result = await provider.decide({
      name: "generation_route",
      state: { renderer: "stickman_motion" },
    });
    expect(result).toMatchObject({
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      answer: { choice: "STICKMAN" },
      usage: { input_tokens: 20 },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toEqual({
      authorization: "Bearer secret-key",
      "content-type": "application/json",
    });
    expect(String(init.body)).not.toContain("secret-key");
  });

  it("rejects malformed or out-of-catalog answers without exposing provider payloads", async () => {
    const provider = createJevDecisionProvider({
      apiKey: "secret-key",
      fetch: async () =>
        Response.json({
          model: "jev-1",
          answers: {
            generation_route: {
              type: "choice",
              choice: "PUBLISH_NOW",
              probabilities: { PUBLISH_NOW: 1 },
              confidence: 1,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    await expect(provider.decide({ name: "generation_route", state: {} })).rejects.toThrow(
      "jev_response_invalid",
    );
  });
});
