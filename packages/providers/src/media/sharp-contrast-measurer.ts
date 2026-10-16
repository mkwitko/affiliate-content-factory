import type { PixelBox } from "@money-maker/core/creatives/creative-renderer";
import sharp from "sharp";

const SIDE = 64;
/** RGB distance under which a pixel counts as the text itself, not what is behind it. */
const TEXT_DISTANCE = 90;
const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (r: number, g: number, b: number): number =>
  0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * WCAG contrast of `textColour` against the pixels behind `box` in a rendered slide. Pixels near
 * the text colour are the glyphs and are ignored; the result is the 10th-percentile contrast of
 * the rest, so one bright patch behind white text counts. Returns null when the box is off-image.
 */
// ponytail: text-colour match stands in for glyph masks; an anti-aliased edge can read as background.
export const measureContrast = async (
  image: Uint8Array,
  box: PixelBox,
  textColour: string,
): Promise<number | null> => {
  const meta = await sharp(image).metadata();
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const width = Math.min(meta.width ?? 0, Math.ceil(box.x + box.w)) - left;
  const height = Math.min(meta.height ?? 0, Math.ceil(box.y + box.h)) - top;
  if (width < 1 || height < 1) return null;
  const { data, info } = await sharp(image)
    .extract({ left, top, width, height })
    .resize(SIDE, SIDE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tr = Number.parseInt(textColour.slice(1, 3), 16);
  const tg = Number.parseInt(textColour.slice(3, 5), 16);
  const tb = Number.parseInt(textColour.slice(5, 7), 16);
  const textLum = lum(tr, tg, tb);
  const ratios: number[] = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    if (Math.hypot(r - tr, g - tg, b - tb) < TEXT_DISTANCE) continue;
    ratios.push(ratio(textLum, lum(r, g, b)));
  }
  if (ratios.length === 0) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length * 0.1)] as number;
};
