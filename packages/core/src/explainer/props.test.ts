import { describe, expect, it } from "vitest";
import { PROPS, renderProp } from "./props.js";

const palette = { line: "#111111", accent: "#ff5a36" };

describe("props", () => {
  it("renders every prop with an optional label", () => {
    for (const type of PROPS) {
      const svg = renderProp({ type, x: 780, y: 1100, label: "R$ 10", palette });
      expect(svg.startsWith("<g")).toBe(true);
      expect(svg).toContain("R$ 10");
      expect(svg).not.toContain("NaN");
    }
  });

  it("omits the label element when no label is given", () => {
    expect(renderProp({ type: "card", x: 0, y: 0, palette })).not.toContain("<text");
  });

  it("escapes label text", () => {
    const svg = renderProp({ type: "coin", x: 0, y: 0, label: "<b>&", palette });
    expect(svg).toContain("&lt;b&gt;&amp;");
  });
});
