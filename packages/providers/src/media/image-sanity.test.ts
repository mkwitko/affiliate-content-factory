import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageDegeneracy } from "./image-sanity.js";

const png = (pixels: Uint8Array, width: number, height: number) =>
  sharp(Buffer.from(pixels), { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

describe("imageDegeneracy", () => {
  it("flags a flat grey field and per-pixel noise, and passes a drawn scene", async () => {
    const w = 256;
    const h = 320;
    const grey = new Uint8Array(w * h).fill(128);
    let seed = 7;
    const noise = grey.map(() => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % 256;
    });
    // A "drawing": flat areas with a few hard edges and a gradient.
    const scene = grey.map((_, i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      if (x > 60 && x < 120 && y > 80 && y < 260) return 30;
      if ((x - 180) ** 2 + (y - 120) ** 2 < 900) return 220;
      return 100 + Math.floor(y / 4);
    });
    expect(await imageDegeneracy(new Uint8Array(await png(grey, w, h)))).toBe("blank");
    expect(await imageDegeneracy(new Uint8Array(await png(noise, w, h)))).toBe("noise");
    expect(await imageDegeneracy(new Uint8Array(await png(scene, w, h)))).toBeNull();
  });
});
