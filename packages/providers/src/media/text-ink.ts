import type { PixelBox } from "@money-maker/core/creatives/creative-renderer";
import sharp from "sharp";

/**
 * Measured typography (brief 13): the ink of every overlay text element, rasterised alone with
 * the bundled font and trimmed, so the slide QA judges real glyph pixels instead of the
 * character-count estimate the layout works with. Elements are found by their `data-box`
 * attribute; the drop-shadow filter is left out so only ink and halo count.
 */
const TEXT = /<text\b[^>]*\bdata-box="([a-z]+)"[^>]*>[\s\S]*?<\/text>/g;

export const inkBoxes = async (
  svg: string,
  size: Readonly<{ w: number; h: number }>,
): Promise<Readonly<Record<string, PixelBox>>> => {
  const byKey = new Map<string, string[]>();
  for (const match of svg.matchAll(TEXT)) {
    const key = match[1] as string;
    byKey.set(key, [...(byKey.get(key) ?? []), match[0].replace(/\sfilter="url\(#sh\)"/g, "")]);
  }
  const out: Record<string, PixelBox> = {};
  for (const [key, parts] of byKey) {
    const image = sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">${parts.join("")}</svg>`,
      ),
    );
    // An all-transparent raster has no ink: nothing to report (trim would give 1x1 or throw).
    const alpha = (
      await image
        .clone()
        .stats()
        .catch(() => null)
    )?.channels[3];
    if (!alpha || alpha.max === 0) continue;
    const { info } = await image
      .trim({ threshold: 8 })
      .toBuffer({ resolveWithObject: true })
      .catch(() => ({ info: null }));
    if (!info || info.trimOffsetLeft === undefined || info.trimOffsetTop === undefined) continue;
    out[key] = {
      x: -info.trimOffsetLeft,
      y: -info.trimOffsetTop,
      w: info.width,
      h: info.height,
    };
  }
  return out;
};
