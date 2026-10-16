import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { COMPOSITE_PLACEMENT, compositeProduct } from "./composite-product.js";

const solid = (width: number, height: number, background: string, alpha = false) =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background } })
    .png()
    .toBuffer();

const pixel = async (png: Uint8Array, x: number, y: number) => {
  const { data } = await sharp(png)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

describe("compositeProduct", () => {
  it("stands furniture on the floor line, centred, scene size kept, backdrop untouched above", async () => {
    const scene = await solid(400, 500, "#e0e0e0");
    const cutout = await solid(100, 200, "#ff0000", true);
    const out = await compositeProduct(scene, cutout, { floor: true });
    expect(await sharp(out).metadata()).toMatchObject({ width: 400, height: 500 });
    const bottom = Math.round(500 * COMPOSITE_PLACEMENT.floor.bottom);
    const h = Math.round(500 * COMPOSITE_PLACEMENT.floor.height);
    expect(await pixel(out, 200, bottom - Math.round(h / 2))).toEqual([255, 0, 0]);
    expect(await pixel(out, 200, bottom - h - 40)).toEqual([224, 224, 224]);
    expect(await pixel(out, 10, 10)).toEqual([224, 224, 224]);
    // A shadow darkens the floor just under the base.
    const [r] = await pixel(out, 200, bottom + 6);
    expect(r).toBeLessThan(224);
  });

  it("sits a small item higher, as on a counter, and caps the width", async () => {
    const scene = await solid(400, 500, "#ffffff");
    const cutout = await solid(400, 100, "#0000ff", true);
    const out = await compositeProduct(scene, cutout, { floor: false });
    const bottom = Math.round(500 * COMPOSITE_PLACEMENT.counter.bottom);
    expect(await pixel(out, 200, bottom - 10)).toEqual([0, 0, 255]);
    // Outside the capped width: only the shadow's faint edge, no blue.
    const [r, , b] = await pixel(out, 20, bottom - 10);
    expect(r).toBeGreaterThan(240);
    expect(b).toBe(r);
  });

  it("refuses an unreadable image", async () => {
    await expect(
      compositeProduct(new Uint8Array([1, 2, 3]), await solid(10, 10, "#fff", true), {
        floor: true,
      }),
    ).rejects.toThrow();
  });
});
