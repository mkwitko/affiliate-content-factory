import { describe, expect, it } from "vitest";
import { mergeEditorialContext } from "./merge-editorial-context.js";

describe("mergeEditorialContext", () => {
  it("lets a later layer override an earlier layer's key", () => {
    const merged = mergeEditorialContext([
      { cta: "Compre agora", mission: "Example Shop" },
      { cta: "Salve este post" },
    ]);
    expect(merged).toEqual({ cta: "Salve este post", mission: "Example Shop" });
  });

  it("treats a null or missing layer as empty", () => {
    expect(mergeEditorialContext([null, undefined, { promise: "x" }])).toEqual({ promise: "x" });
  });

  it("returns an empty object for no layers", () => {
    expect(mergeEditorialContext([])).toEqual({});
  });
});
