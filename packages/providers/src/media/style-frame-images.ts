import sharp from "sharp";

/**
 * sharp helpers for the style-frame harness (video slice 13): full-frame PNG rasters, 160x284
 * thumbnails, labelled side-by-side sheets and the harness-only plate grades. Review tooling,
 * not a production render path.
 */
export const STYLE_FRAME_SIZE = Object.freeze({ width: 1080, height: 1920 });
export const STYLE_THUMB_SIZE = Object.freeze({ width: 160, height: 284 });

export type PlateGrade = Readonly<{ brightness: number; saturation: number; tint: string }>;

export const imageVersions = (): Readonly<{ sharp: string; vips: string }> => ({
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
});

export const rasterizeFrame = async (svg: string): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(Buffer.from(svg), { density: 72 })
      .resize(STYLE_FRAME_SIZE.width, STYLE_FRAME_SIZE.height, { fit: "fill" })
      .png({ compressionLevel: 6 })
      .toBuffer(),
  );

export const thumbnailFrame = async (png: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(Buffer.from(png))
      .resize(STYLE_THUMB_SIZE.width, STYLE_THUMB_SIZE.height, { fit: "fill" })
      .png()
      .toBuffer(),
  );

const labelSvg = (text: string, width: number, size: number): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size * 2}"><rect width="${width}" height="${size * 2}" fill="#161616" fill-opacity="0.75"/><text x="${width / 2}" y="${size * 1.45}" font-family="Inter, sans-serif" font-size="${size}" font-weight="700" fill="#ffffff" text-anchor="middle">${text}</text></svg>`,
  );

/** Tiles PNGs left to right at one size, a label banner over each (empty label = none). */
export const tileSheet = async (
  tiles: readonly Readonly<{ label: string; png: Uint8Array }>[],
  tile: Readonly<{ width: number; height: number }>,
): Promise<Uint8Array> => {
  const gap = 8;
  const width = tiles.length * tile.width + (tiles.length - 1) * gap;
  const size = Math.max(14, Math.round(tile.width / 12));
  const composites = await Promise.all(
    tiles.map(async (entry, i) => {
      const left = i * (tile.width + gap);
      const scaled = await sharp(Buffer.from(entry.png))
        .resize(tile.width, tile.height, { fit: "fill" })
        .png()
        .toBuffer();
      return [
        { input: scaled, left, top: 0 },
        ...(entry.label ? [{ input: labelSvg(entry.label, tile.width, size), left, top: 0 }] : []),
      ];
    }),
  );
  return new Uint8Array(
    await sharp({ create: { width, height: tile.height, channels: 3, background: "#808080" } })
      .composite(composites.flat())
      .png()
      .toBuffer(),
  );
};

/** Brightness, saturation and tint on a plate (JPEG out); the harness records the spec used. */
export const gradePlateImage = async (bytes: Uint8Array, grade: PlateGrade): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(Buffer.from(bytes))
      .modulate({ brightness: grade.brightness, saturation: grade.saturation })
      .tint(grade.tint)
      .jpeg({ quality: 90 })
      .toBuffer(),
  );
