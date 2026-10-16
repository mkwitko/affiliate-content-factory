import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { applyMask, removeWhiteBackground } from "./white-background-remover.js";
import { classifyPicture, rankPictures } from "./picture-classifier.js";

const svg = (inner: string, bg = "#ffffff") =>
  sharp(
    Buffer.from(
      `<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="400" fill="${bg}"/>${inner}</svg>`,
    ),
  )
    .png()
    .toBuffer();

describe("removeWhiteBackground", () => {
  it("cuts a dark object and removes an enclosed white hole", async () => {
    const png = await svg(
      '<rect x="100" y="100" width="200" height="200" fill="#222"/><rect x="150" y="150" width="100" height="100" fill="#fff"/>',
    );
    const cut = await removeWhiteBackground(new Uint8Array(png));
    expect(cut.metrics.coverage).toBeCloseTo(0.1875, 1);
    expect(cut.metrics.components).toBe(1);
    const alpha = await sharp(cut.png).extractChannel(3).raw().toBuffer();
    expect(alpha[200 * 400 + 200]).toBe(0);
    expect(alpha[120 * 400 + 120]).toBe(255);
  });

  it("reports low contrast for a white-on-white object", async () => {
    const png = await svg('<rect x="100" y="100" width="200" height="200" fill="#f4f4f4"/>');
    const cut = await removeWhiteBackground(new Uint8Array(png));
    expect(cut.metrics.contrast).toBeLessThan(25);
  });

  it("classifies white studio and grey studio photos", async () => {
    const white = new Uint8Array(await svg('<circle cx="200" cy="200" r="80" fill="#333"/>'));
    const grey = new Uint8Array(
      await svg('<circle cx="200" cy="200" r="80" fill="#333"/>', "#888"),
    );
    expect((await classifyPicture(white)).suggested).toBe("local-white");
    expect((await classifyPicture(grey)).suggested).toBe("segment");
    const ranked = await rankPictures([
      { bytes: grey, width: 400, height: 400 },
      { bytes: white, width: 400, height: 400 },
    ]);
    expect(ranked[0]?.index).toBe(1);
  });
});

describe("applyMask", () => {
  it("cuts the original pixels of a non-white photo with an external mask of another size", async () => {
    const photo = new Uint8Array(
      await svg('<circle cx="200" cy="200" r="80" fill="#c0392b"/>', "#888888"),
    );
    const mask = new Uint8Array(
      await sharp(
        Buffer.from(
          '<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#000"/><circle cx="100" cy="100" r="40" fill="#fff"/></svg>',
        ),
      )
        .png()
        .toBuffer(),
    );
    const cut = await applyMask(photo, mask);
    expect([cut.width, cut.height]).toEqual([400, 400]);
    expect(cut.metrics.components).toBe(1);
    expect(cut.metrics.coverage).toBeCloseTo((Math.PI * 80 * 80) / (400 * 400), 1);
    expect(cut.metrics.whiteness).toBe(0);
    const { data } = await sharp(cut.png).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [
      ...data.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4),
    ];
    expect(at(200, 200)).toEqual([0xc0, 0x39, 0x2b, 255]);
    expect(at(10, 10)[3]).toBe(0);
  });

  it("reports an empty mask as zero coverage", async () => {
    const photo = new Uint8Array(
      await svg('<circle cx="200" cy="200" r="80" fill="#333"/>', "#888"),
    );
    const black = new Uint8Array(
      await sharp({ create: { width: 50, height: 50, channels: 3, background: "#000000" } })
        .png()
        .toBuffer(),
    );
    const cut = await applyMask(photo, black);
    expect(cut.metrics.coverage).toBe(0);
    expect(cut.metrics.components).toBe(0);
  });
});
