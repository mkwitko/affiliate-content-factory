import { describe, expect, it } from "vitest";
import { configureBundledFonts } from "./fonts.js";
import { inkBoxes } from "./text-ink.js";

describe("inkBoxes", () => {
  it("measures each tagged text element's ink and ignores untagged shapes", async () => {
    configureBundledFonts();
    const svg = `<rect x="0" y="0" width="400" height="400" fill="#f00"/><text x="20" y="100" font-family="Inter" font-size="40" font-weight="700" fill="#000" data-box="headline" filter="url(#sh)">Hello</text><text x="200" y="300" text-anchor="middle" font-family="Inter" font-size="20" fill="#000" data-box="cta">Buy</text>`;
    const ink = await inkBoxes(svg, { w: 400, h: 400 });
    expect(Object.keys(ink).sort()).toEqual(["cta", "headline"]);
    const head = ink.headline as { x: number; y: number; w: number; h: number };
    expect(head.x).toBeGreaterThanOrEqual(18);
    expect(head.x).toBeLessThan(30);
    expect(head.y + head.h).toBeGreaterThan(90);
    expect(head.y + head.h).toBeLessThan(104);
    expect(head.w).toBeGreaterThan(80);
    expect(head.w).toBeLessThan(130);
    const cta = ink.cta as { x: number; w: number };
    expect(cta.x + cta.w / 2).toBeGreaterThan(190);
    expect(cta.x + cta.w / 2).toBeLessThan(210);
  });

  it("reports nothing for an element without ink", async () => {
    const ink = await inkBoxes(`<text x="10" y="10" font-size="10" data-box="body"> </text>`, {
      w: 50,
      h: 50,
    });
    expect(ink).toEqual({});
  });
});
