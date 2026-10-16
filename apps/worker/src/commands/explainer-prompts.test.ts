import { describe, expect, it } from "vitest";
import { explainerPrompts } from "./explainer-prompts.js";

describe("explainerPrompts", () => {
  it("prints one background and loop prompt per procedural setting for a style", () => {
    const out = explainerPrompts("flat_cartoon", "navy and cyan");
    expect(out).toMatchObject({
      promptVersion: 1,
      style: "flat_cartoon",
      size: { width: 768, height: 1344 },
    });
    expect(out.items.map((item) => item.setting)).toHaveLength(10);
    expect(
      out.items.every(
        (item) =>
          item.prompt.includes("no people") &&
          item.prompt.includes("navy and cyan palette") &&
          item.loopPrompt.includes("static camera"),
      ),
    ).toBe(true);
  });
});
