import type { ReferenceEvidence } from "@money-maker/core/creatives/reference-pick";
import sharp from "sharp";

const SIDE = 256;
const BORDER = 4;
const NEAR_WHITE = 235;

/**
 * Measures a listing photo for the reference pick: Laplacian variance (sharpness) and the
 * near-white share of the border, both on a 256 px greyscale copy; size from the metadata.
 */
export const referenceEvidence = async (bytes: Uint8Array): Promise<ReferenceEvidence> => {
  const meta = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes)
    .resize(SIDE, SIDE, { fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = (x: number, y: number) => data[y * w + x] as number;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const lap = 4 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1) - px(x, y + 1);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  const mean = n ? sum / n : 0;
  const sharpness = n ? sumSq / n - mean * mean : 0;
  let border = 0;
  let white = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= BORDER && x < w - BORDER && y >= BORDER && y < h - BORDER) continue;
      border++;
      if (px(x, y) >= NEAR_WHITE) white++;
    }
  return {
    sharpness,
    whiteBorderShare: border ? white / border : 0,
    width: meta.width ?? w,
    height: meta.height ?? h,
  };
};
