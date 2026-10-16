import { describe, expect, it } from "vitest";
import { BACKGROUNDS, renderBackground } from "./backgrounds.js";

const palette = { surface: "#f6f1e7", muted: "#d9d2c5", accent: "#ff5a36" };

describe("backgrounds", () => {
  it("renders every background as a full-frame layer", () => {
    for (const id of BACKGROUNDS) {
      const svg = renderBackground(id, palette);
      expect(svg.startsWith("<g")).toBe(true);
      expect(svg).toContain(`width="1080" height="1920" fill="${palette.surface}"`);
    }
  });

  it("gives each background a distinct drawing", () => {
    expect(new Set(BACKGROUNDS.map((id) => renderBackground(id, palette))).size).toBe(
      BACKGROUNDS.length,
    );
  });
});
