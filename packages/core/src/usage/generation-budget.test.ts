import { describe, expect, it } from "vitest";
import { decideSceneBudget, utcDayStart } from "./generation-budget.js";

describe("decideSceneBudget", () => {
  it("generates below 80%, reuses below 95%, then stays procedural", () => {
    expect(decideSceneBudget(0)).toBe("generate");
    expect(decideSceneBudget(7_999)).toBe("generate");
    expect(decideSceneBudget(8_000)).toBe("reuse_only");
    expect(decideSceneBudget(9_500)).toBe("procedural_only");
  });

  it("computes the UTC day start", () => {
    expect(utcDayStart(new Date("2026-09-25T23:59:00-03:00")).toISOString()).toBe(
      "2026-09-26T00:00:00.000Z",
    );
  });
});
