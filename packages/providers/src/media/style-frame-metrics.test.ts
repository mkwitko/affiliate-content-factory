import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { measureFrames } from "./style-frame-metrics.js";

const frame = (svg: string) =>
  sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">${svg}</svg>`),
  )
    .png()
    .toBuffer()
    .then((b) => new Uint8Array(b));

describe("measureFrames", () => {
  it("measures areas, the accent share and value tiers on synthetic frames", async () => {
    const light = await frame(
      `<rect width="1080" height="1920" fill="#F6F1E7"/><rect y="1440" width="1080" height="480" fill="#FF5A36"/>`,
    );
    const dark = await frame(`<rect width="1080" height="1920" fill="#161616"/>`);
    const m = await measureFrames([light, dark], "#FF5A36");
    expect(m.frames).toBe(2);
    expect(m.dominantArea).toBeCloseTo(0.5, 2);
    expect(m.secondaryArea).toBeCloseTo(0.375, 1); // resize blends the edge row
    expect(m.accentArea).toBeCloseTo(0.125, 2);
    expect(m.valueTiers[0]).toBeCloseTo(0.5, 2);
    expect(m.valueTiers[0] + m.valueTiers[1] + m.valueTiers[2]).toBeCloseTo(1, 3);
  });

  it("refuses an empty set", async () => {
    await expect(measureFrames([], "#FF5A36")).rejects.toThrow("style_frames_empty");
  });
});
