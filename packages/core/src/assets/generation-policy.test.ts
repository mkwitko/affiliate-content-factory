import { describe, expect, it } from "vitest";
import {
  cloudGenerationAllowed,
  GENERATION_POLICIES,
  parseGenerationPolicy,
} from "./generation-policy.js";

describe("generation policy", () => {
  it("defaults to cloud_allowed and accepts every listed value", () => {
    expect(parseGenerationPolicy(undefined)).toBe("cloud_allowed");
    expect(parseGenerationPolicy("  ")).toBe("cloud_allowed");
    for (const policy of GENERATION_POLICIES) expect(parseGenerationPolicy(policy)).toBe(policy);
  });

  it("rejects unknown values", () => {
    expect(() => parseGenerationPolicy("local")).toThrow("generation_policy_invalid");
    expect(() => parseGenerationPolicy("LOCAL_ONLY")).toThrow("generation_policy_invalid");
  });

  it("blocks cloud generation only under local_only", () => {
    expect(cloudGenerationAllowed("local_only")).toBe(false);
    expect(cloudGenerationAllowed("local_first")).toBe(true);
    expect(cloudGenerationAllowed("cloud_allowed")).toBe(true);
  });
});
