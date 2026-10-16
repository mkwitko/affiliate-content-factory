import sharp from "sharp";

export type FittedImage = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}>;

const supportedFormats = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

// Reads real dimensions from the bytes; with a canvas, letterboxes the whole image onto it
// (no crop, white bars) so a product photo keeps every detail at the channel's exact size.
// `cover` instead fills the canvas and trims the centred overflow, for finished slides.
export const fitImage = async (
  bytes: Uint8Array,
  canvas?: Readonly<{ width: number; height: number }>,
  fit: "contain" | "cover" = "contain",
): Promise<FittedImage> => {
  if (canvas) {
    const output = await sharp(bytes)
      .rotate()
      .resize(canvas.width, canvas.height, { fit, background: "#ffffff" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { bytes: new Uint8Array(output), mimeType: "image/jpeg", ...canvas };
  }
  const metadata = await sharp(bytes).metadata();
  const mimeType = supportedFormats[metadata.format as keyof typeof supportedFormats];
  if (!mimeType || !metadata.width || !metadata.height) throw new Error("unsupported_image");
  return { bytes, mimeType, width: metadata.width, height: metadata.height };
};

/** Standard deviation of luma (0-255); near zero means an empty or uniform picture. */
export const lumaStdev = async (bytes: Uint8Array): Promise<number> =>
  (await sharp(bytes).greyscale().stats()).channels[0]?.stdev ?? 0;

// One solid color (every channel's spread near zero): an empty design page, never a slide.
export const isBlankImage = async (bytes: Uint8Array): Promise<boolean> => {
  const { channels } = await sharp(bytes).stats();
  return channels.slice(0, 3).every((channel) => channel.stdev < 2);
};

/**
 * Decodes an untrusted PNG or JPEG completely and re-encodes it in the same format, so only
 * pixels survive: trailing data is dropped, truncated files and pixel bombs are refused.
 */
export const reencodeImage = async (
  bytes: Uint8Array,
  maxPixels = 4096 * 4096,
): Promise<
  Readonly<{
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
  }>
> => {
  const image = sharp(bytes, { limitInputPixels: maxPixels, failOn: "truncated" });
  const { format } = await image.metadata();
  if (format !== "png" && format !== "jpeg") throw new Error("unsupported_image");
  const { data, info } = await (format === "png"
    ? image.png()
    : image.jpeg({ quality: 92 })
  ).toBuffer({
    resolveWithObject: true,
  });
  return {
    bytes: new Uint8Array(data),
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    width: info.width,
    height: info.height,
  };
};
