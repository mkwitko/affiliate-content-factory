import sharp from "sharp";
import { oklab } from "@money-maker/core/explainer/compositing";

/**
 * Pixel measurements of accepted style frames (v2 slice 18, spec section 9: palette areas,
 * value tiers, accent share, chroma). Frames are sampled at 108x192 (1/10 linear); the numbers
 * describe a look, they do not judge it.
 */
export type FrameMeasurements = Readonly<{
  frames: number;
  /** Share of pixels in the most common, second most common colour bins (32 levels per channel). */
  dominantArea: number;
  secondaryArea: number;
  /** Share of pixels within OKLab distance 0.08 of the accent. */
  accentArea: number;
  /** Shares of OKLab L < 0.45, 0.45..0.75, ≥ 0.75. */
  valueTiers: readonly [number, number, number];
  meanChroma: number;
}>;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export const measureFrames = async (
  pngs: readonly Uint8Array[],
  accentHex: string,
): Promise<FrameMeasurements> => {
  const accentValue = Number.parseInt(accentHex.slice(1), 16);
  const accent = oklab((accentValue >> 16) & 255, (accentValue >> 8) & 255, accentValue & 255);
  const bins = new Map<number, number>();
  let total = 0;
  let accentPx = 0;
  let chroma = 0;
  let dark = 0;
  let mid = 0;
  let light = 0;
  for (const png of pngs) {
    const { data } = await sharp(Buffer.from(png))
      .resize(108, 192, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      bins.set(key, (bins.get(key) ?? 0) + 1);
      const [l, a, bb] = oklab(r, g, b);
      chroma += Math.hypot(a, bb);
      if (Math.hypot(l - accent[0], a - accent[1], bb - accent[2]) < 0.08) accentPx += 1;
      if (l < 0.45) dark += 1;
      else if (l < 0.75) mid += 1;
      else light += 1;
      total += 1;
    }
  }
  if (total === 0) throw new Error("style_frames_empty");
  const counts = [...bins.values()].sort((a, b) => b - a);
  return {
    frames: pngs.length,
    dominantArea: round3((counts[0] ?? 0) / total),
    secondaryArea: round3((counts[1] ?? 0) / total),
    accentArea: round3(accentPx / total),
    valueTiers: [round3(dark / total), round3(mid / total), round3(light / total)],
    meanChroma: round3(chroma / total),
  };
};
