import { colourCheckPasses } from "@money-maker/core/creatives/in-scene-fidelity";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { colourEvidence, productColours } from "./sharp-colour-evidence.js";

const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

describe("colourEvidence", () => {
  it("finds a red product colour in a scene that contains red and not in a blue one", async () => {
    const red = await solid(200, 20, 20);
    const redScene = await solid(205, 25, 25);
    const blueScene = await solid(20, 20, 200);
    expect(colourCheckPasses(await colourEvidence(red, redScene))).toBe(true);
    expect(colourCheckPasses(await colourEvidence(red, blueScene))).toBe(false);
  });
  it("ignores transparent pixels of the cutout", async () => {
    const cutout = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 20, b: 20 } },
          })
            .png()
            .toBuffer(),
          left: 10,
          top: 10,
        },
      ])
      .png()
      .toBuffer();
    const evidence = await colourEvidence(cutout, await solid(200, 20, 20));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.productShare).toBeGreaterThan(0.8);
  });
});

describe("productColours", () => {
  it("names the product colour of a photo and ignores its white background", async () => {
    const photo = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 32, height: 32, channels: 3, background: { r: 15, g: 15, b: 15 } },
          })
            .png()
            .toBuffer(),
          left: 16,
          top: 16,
        },
      ])
      .png()
      .toBuffer();
    const colours = await productColours(photo);
    expect(colours).toHaveLength(1);
    expect(colours[0]?.[0]).toBeLessThan(40);
  });
});

describe("productColours on a shaded product", () => {
  it("finds a dark product whose shading spreads over many fine buckets", async () => {
    // Grey 0..127 down a bar on white: each 16-level bucket holds 12.5 % (< 15 % minimum share).
    const rows = Array.from(
      { length: 96 },
      (_, y) =>
        `<rect x="20" y="${y}" width="56" height="1" fill="rgb(${Math.round((y * 127) / 95)},${Math.round((y * 127) / 95)},${Math.round((y * 127) / 95)})"/>`,
    ).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#fff"/>${rows}</svg>`;
    const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
    const colours = await productColours(png);
    expect(colours.length).toBeGreaterThan(0);
    expect(Math.max(...(colours[0] as readonly number[]))).toBeLessThan(128);
  });
});
