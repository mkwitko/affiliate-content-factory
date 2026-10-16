import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { measureContrast } from "./sharp-contrast-measurer.js";

const image = (inner: string) =>
  sharp(
    Buffer.from(`<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`),
  )
    .png()
    .toBuffer();
const box = { x: 20, y: 20, w: 200, h: 100 };
const word = (fill: string) =>
  `<text x="30" y="90" font-size="60" font-family="sans-serif" fill="${fill}">Hi</text>`;

describe("measureContrast", () => {
  it("reads high contrast for dark text on white", async () => {
    const png = await image(`<rect width="400" height="200" fill="#fff"/>${word("#111111")}`);
    expect(await measureContrast(png, box, "#111111")).toBeGreaterThan(15);
  });
  it("reads low contrast for white text on a light background", async () => {
    const png = await image(`<rect width="400" height="200" fill="#e8e8e8"/>${word("#ffffff")}`);
    expect(await measureContrast(png, box, "#ffffff")).toBeLessThan(1.3);
  });
  it("counts a bright patch behind white text", async () => {
    const png = await image(
      `<rect width="400" height="200" fill="#202030"/><rect x="20" y="20" width="60" height="100" fill="#c8c8c8"/>${word("#ffffff")}`,
    );
    expect(await measureContrast(png, box, "#ffffff")).toBeLessThan(2);
  });
  it("returns null for a box outside the image", async () => {
    const png = await image(`<rect width="400" height="200" fill="#fff"/>`);
    expect(await measureContrast(png, { x: 900, y: 900, w: 50, h: 50 }, "#000000")).toBeNull();
  });
});
