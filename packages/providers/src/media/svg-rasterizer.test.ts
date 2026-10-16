import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { rasterizeSvg } from "./svg-rasterizer.js";

describe("rasterizeSvg", () => {
  it("returns a PNG of the requested size", async () => {
    const png = await rasterizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="100%" height="100%" fill="#ff0000"/></svg>`,
      { width: 1080, height: 1920 },
    );
    const image = sharp(Buffer.from(png));
    const meta = await image.metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1080, 1920]);
    const { data } = await image.raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 0, 0]);
  });

  it("rejects malformed svg", async () => {
    await expect(rasterizeSvg("<svg", { width: 10, height: 10 })).rejects.toThrow();
  });
});
