import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { deltaE2000, measureProductFidelity } from "./sharp-fidelity-measurer.js";

const svg = (width: number, height: number, inner: string) =>
  sharp(
    Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`,
    ),
  );
/** A cutout-like product layer: transparent background, red body, dark label with light stripes. */
const layer = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await svg(
      300,
      300,
      '<rect x="60" y="40" width="180" height="230" rx="30" fill="#c0392b"/><rect x="90" y="100" width="120" height="60" fill="#1f2a36"/><rect x="100" y="112" width="90" height="8" fill="#f5f5f5"/><rect x="100" y="130" width="60" height="8" fill="#f5f5f5"/><circle cx="150" cy="220" r="16" fill="#f1c40f"/>',
    )
      .png()
      .toBuffer(),
  );
const slideWith = async (product: Uint8Array, extra = ""): Promise<Uint8Array> => {
  const base = await sharp({
    create: { width: 1080, height: 1350, channels: 3, background: "#33aa66" },
  })
    .composite([{ input: Buffer.from(product), left: 400, top: 500 }])
    .png()
    .toBuffer();
  const withExtra = extra
    ? await sharp(base)
        .composite([
          {
            input: Buffer.from(
              `<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">${extra}</svg>`,
            ),
          },
        ])
        .png()
        .toBuffer()
    : base;
  return new Uint8Array(await sharp(withExtra).jpeg({ quality: 92 }).toBuffer());
};
const region = { x: 400, y: 500, w: 300, h: 300 };

describe("deltaE2000", () => {
  it("matches the Sharma, Wu and Dalal (2005) reference pairs", () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaE2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(
      1.2644,
      4,
    );
  });
});

describe("measureProductFidelity", () => {
  it("scores an untouched product composited over a background as near perfect", async () => {
    const product = await layer();
    const metrics = await measureProductFidelity({
      original: product,
      rendered: await slideWith(product),
      region,
    });
    expect(metrics.maskIou).toBeGreaterThan(0.95);
    expect(metrics.deltaE).toBeLessThan(1.5);
    expect(metrics.msSsim).toBeGreaterThan(0.98);
    expect(metrics.edgeRecall).toBeGreaterThan(0.95);
    expect(metrics.edgeExcess).toBeLessThan(0.05);
    expect(metrics.inventedText).toEqual([]);
  });

  it("drops structure and adds edges when text is drawn over the product", async () => {
    const product = await layer();
    const metrics = await measureProductFidelity({
      original: product,
      rendered: await slideWith(
        product,
        '<text x="420" y="690" font-size="80" font-family="sans-serif" fill="#ffffff">OFERTA</text>',
      ),
      region,
    });
    expect(metrics.msSsim).toBeLessThan(0.95);
    expect(metrics.edgeExcess).toBeGreaterThan(0.1);
  });

  it("returns unmeasured metrics for an empty mask", async () => {
    const empty = new Uint8Array(await svg(300, 300, "").png().toBuffer());
    const metrics = await measureProductFidelity({
      original: empty,
      rendered: await slideWith(await layer()),
      region,
    });
    expect(metrics).toEqual({
      maskIou: null,
      deltaE: null,
      msSsim: null,
      edgeRecall: null,
      edgeExcess: null,
      inventedText: [],
    });
  });

  it("rejects a region outside the rendered image", async () => {
    const product = await layer();
    await expect(
      measureProductFidelity({
        original: product,
        rendered: await slideWith(product),
        region: { x: 900, y: 500, w: 300, h: 300 },
      }),
    ).rejects.toThrow("fidelity_region_invalid");
  });
});
