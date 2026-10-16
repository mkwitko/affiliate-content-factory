import sharp from "sharp";

/** Rasterizes a composed scene SVG (fonts resolve through fontconfig, Inter in the image). */
export const rasterizeSvg = async (
  svg: string,
  size: Readonly<{ width: number; height: number }>,
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(Buffer.from(svg, "utf8"), { density: 72 })
      .resize(size.width, size.height, { fit: "fill" })
      .png({ compressionLevel: 6 })
      .toBuffer(),
  );

/** Caps libvips worker threads for every sharp call in this process (RENDER_THREADS). */
export const limitImageThreads = (threads: number): void => {
  sharp.concurrency(threads);
};
