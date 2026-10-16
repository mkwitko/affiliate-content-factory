import { describe, expect, it } from "vitest";
import { assertFontsPresent, fontFile } from "./fonts.js";

describe("bundled Inter fonts", () => {
  it("resolves and verifies the required weights", () => {
    assertFontsPresent();
    for (const weight of [400, 700, 800] as const) expect(fontFile(weight)).toContain("Inter-");
  });
});
