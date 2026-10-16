import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { referenceEvidence } from "./sharp-reference-evidence.js";

/** A dark square on white; `blur` softens its edges. */
const square = async (blur?: number) => {
  let image = sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite([
    {
      input: await sharp({
        create: { width: 160, height: 160, channels: 3, background: { r: 30, g: 30, b: 30 } },
      })
        .png()
        .toBuffer(),
      left: 120,
      top: 120,
    },
  ]);
  if (blur) image = sharp(await image.png().toBuffer()).blur(blur);
  return new Uint8Array(await image.png().toBuffer());
};

describe("referenceEvidence", () => {
  it("reads a crisp product on white as sharper and cleaner than its blurred, grey copy", async () => {
    const crisp = await referenceEvidence(await square());
    const soft = await referenceEvidence(await square(12));
    expect(crisp.width).toBe(400);
    expect(crisp.sharpness).toBeGreaterThan(soft.sharpness);
    expect(crisp.whiteBorderShare).toBeGreaterThan(0.95);
    const grey = await referenceEvidence(
      new Uint8Array(
        await sharp({
          create: { width: 400, height: 400, channels: 3, background: { r: 120, g: 120, b: 120 } },
        })
          .png()
          .toBuffer(),
      ),
    );
    expect(grey.whiteBorderShare).toBe(0);
    expect(grey.sharpness).toBe(0);
  });
});
