import { describe, expect, it } from "vitest";
import {
  CAPTION_BAND,
  FRAME,
  MEDIA_CAPTION_MARGIN_V,
  escapeXml,
  fitFontSize,
  positionX,
} from "./layout.js";

describe("frame layout", () => {
  it("places the caption baseline margin at the bottom of the caption band", () => {
    expect(FRAME.height - MEDIA_CAPTION_MARGIN_V).toBe(CAPTION_BAND.bottom);
  });
  it("maps stage positions to x", () => {
    expect([positionX("left"), positionX("center"), positionX("right")]).toEqual([300, 540, 780]);
  });
  it("escapes xml", () => {
    expect(escapeXml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("fitFontSize", () => {
  it("keeps the base size for short text", () => {
    expect(fitFontSize("WHY?", 92, 750)).toBe(92);
  });
  it("shrinks long text to the available width", () => {
    const size = fitFontSize("HOW BANKS REALLY PROFIT!", 92, 750);
    expect(size).toBeLessThan(92);
    expect(size * 24 * 0.66).toBeLessThanOrEqual(750);
  });
});
