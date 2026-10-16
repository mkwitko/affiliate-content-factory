import sharp from "sharp";

/**
 * Catches generations that decode but show nothing: a flat field (luma stdev below 4) or
 * per-pixel noise (less than 35 % of neighbouring pixels within 6 grey levels; illustrations and
 * photos measured 0.5-0.99, broken runtimes 0.13-0.18 on 2026-10-07). Measured on a 128 px wide
 * grey copy, so it costs milliseconds.
 */
export const IMAGE_SANITY = { minStdev: 4, minSmoothShare: 0.35, smoothDelta: 6 } as const;

export const imageDegeneracy = async (bytes: Uint8Array): Promise<"blank" | "noise" | null> => {
  const { data, info } = await sharp(bytes)
    .greyscale()
    .resize(128, null)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let squares = 0;
  for (const v of data) {
    sum += v;
    squares += v * v;
  }
  const mean = sum / data.length;
  if (Math.sqrt(Math.max(0, squares / data.length - mean * mean)) < IMAGE_SANITY.minStdev)
    return "blank";
  let smooth = 0;
  let pairs = 0;
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x + 1 < info.width; x += 1) {
      const at = y * info.width + x;
      pairs += 1;
      if (Math.abs((data[at] as number) - (data[at + 1] as number)) < IMAGE_SANITY.smoothDelta)
        smooth += 1;
    }
  return pairs && smooth / pairs < IMAGE_SANITY.minSmoothShare ? "noise" : null;
};
