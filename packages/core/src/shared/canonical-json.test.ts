import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });
  it("keeps array order and primitives", () => {
    expect(canonicalJson([3, "x", null, true])).toBe('[3,"x",null,true]');
    expect(canonicalJson("a")).toBe('"a"');
  });
});
