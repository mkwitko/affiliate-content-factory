import { describe, expect, it } from "vitest";
import { burnInRefusals, parseBurnInArgs } from "./autonomy-burn-in.js";

describe("parseBurnInArgs", () => {
  it("applies defaults and collects repeated workspaces", () => {
    expect(parseBurnInArgs(["--no-publish", "--workspace=a", "--workspace=b"])).toEqual({
      hours: 24,
      intervalMin: 10,
      workspaces: ["a", "b"],
      noPublish: true,
      out: null,
    });
  });
  it("rejects unknown flags and bad numbers", () => {
    expect(() => parseBurnInArgs(["--publish"])).toThrow("unknown_argument");
    expect(() => parseBurnInArgs(["--hours=0"])).toThrow("invalid_hours");
  });
});

describe("burnInRefusals", () => {
  const ok = { noPublish: true, generationPolicy: "local_only", publicationModes: { w: "paused" } };
  it("allows a local_only, non-publishing run on paused or manual workspaces", () => {
    expect(burnInRefusals(ok)).toEqual([]);
    expect(burnInRefusals({ ...ok, publicationModes: { w: "manual" } })).toEqual([]);
  });
  it("refuses a missing --no-publish, cloud generation and policy_based publishing", () => {
    expect(burnInRefusals({ ...ok, noPublish: false })).toHaveLength(1);
    expect(burnInRefusals({ ...ok, generationPolicy: undefined })).toHaveLength(1);
    expect(burnInRefusals({ ...ok, generationPolicy: "local_first" })).toHaveLength(1);
    expect(burnInRefusals({ ...ok, generationPolicy: "bogus" })).toHaveLength(1);
    expect(burnInRefusals({ ...ok, publicationModes: { w: "policy_based" } })).toHaveLength(1);
  });
});
