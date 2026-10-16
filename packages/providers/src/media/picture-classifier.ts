import sharp from "sharp";
import type { PictureClass } from "@money-maker/core/creatives/canonical-product";
export type { PictureClass } from "@money-maker/core/creatives/canonical-product";
export type PictureInput = Readonly<{ bytes: Uint8Array; width: number; height: number }>;
export type RankedPicture = Readonly<{ index: number; score: number; cls: PictureClass }>;

const isWhite = (data: Buffer, offset: number): boolean => {
  const red = data[offset] ?? 0;
  const green = data[offset + 1] ?? 0;
  const blue = data[offset + 2] ?? 0;
  return (
    Math.min(red, green, blue) > 235 && Math.max(red, green, blue) - Math.min(red, green, blue) < 12
  );
};

export const classifyPicture = async (bytes: Uint8Array): Promise<PictureClass> => {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let borderCount = 0;
  let whiteCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let edges = 0;
  let edgeCandidates = 0;
  const luma = (offset: number) =>
    0.2126 * (data[offset] ?? 0) +
    0.7152 * (data[offset + 1] ?? 0) +
    0.0722 * (data[offset + 2] ?? 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        borderCount += 1;
        if (isWhite(data, offset)) whiteCount += 1;
      }
      if (!isWhite(data, offset)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (x + 1 < width) {
        edgeCandidates += 1;
        if (Math.abs(luma(offset) - luma(offset + channels)) > 20) edges += 1;
      }
      if (y + 1 < height) {
        edgeCandidates += 1;
        if (Math.abs(luma(offset) - luma(offset + width * channels)) > 20) edges += 1;
      }
    }
  }
  const whiteness = borderCount ? whiteCount / borderCount : 0;
  const margin =
    maxX < 0
      ? 0
      : Math.min(minX, minY, width - 1 - maxX, height - 1 - maxY) / Math.min(width, height);
  const suggested = whiteness < 0.6 ? "segment" : margin === 0 ? "framed" : "local-white";
  return {
    whiteness,
    edgeDensity: edgeCandidates ? edges / edgeCandidates : 0,
    suggested,
  };
};

export const rankPictures = async (
  pictures: readonly PictureInput[],
): Promise<readonly RankedPicture[]> => {
  const ranked = await Promise.all(
    pictures.map(async (picture, index) => {
      const cls = await classifyPicture(picture.bytes);
      const score =
        0.5 * cls.whiteness +
        0.3 * Math.min(1, picture.width / 1200) +
        0.2 * (1 - cls.edgeDensity * 10) -
        (cls.suggested === "framed" ? 0.5 : 0);
      return { index, score, cls };
    }),
  );
  return ranked.sort((left, right) => right.score - left.score || left.index - right.index);
};
