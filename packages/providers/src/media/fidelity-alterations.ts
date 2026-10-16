import sharp from "sharp";

/**
 * Deterministic good/altered copies of one product photo for fidelity tests and calibration
 * (spec 8.6). Good copies are transforms a pipeline may legitimately apply; altered copies are
 * the failures the gate must catch. Detail and silhouette patches are proportional to the photo,
 * so they also work on real listing photos whose logo position is unknown.
 */
export const ALTERATIONS = {
  legit_jpeg: "good",
  legit_resample: "good",
  colour_shift: "altered",
  detail_blanked: "altered",
  silhouette_crop: "altered",
} as const;
export type Alteration = keyof typeof ALTERATIONS;

const patch = (width: number, height: number, box: string, fill: string) => ({
  input: Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect ${box} fill="${fill}"/></svg>`,
  ),
});
const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");

export const alterPhoto = async (photo: Uint8Array, kind: Alteration): Promise<Uint8Array> => {
  const image = sharp(photo).rotate().removeAlpha();
  const { width = 0, height = 0 } = await image
    .clone()
    .png()
    .toBuffer({ resolveWithObject: true })
    .then((out) => out.info);
  if (kind === "legit_jpeg") return new Uint8Array(await image.jpeg({ quality: 85 }).toBuffer());
  if (kind === "legit_resample") {
    const down = await image
      .resize(Math.round(width * 0.875), Math.round(height * 0.875))
      .png()
      .toBuffer();
    return new Uint8Array(
      await sharp(down).resize(width, height, { fit: "fill" }).png().toBuffer(),
    );
  }
  if (kind === "colour_shift")
    return new Uint8Array(await image.modulate({ hue: 90 }).png().toBuffer());
  if (kind === "detail_blanked") {
    const box = {
      left: Math.round(width * 0.35),
      top: Math.round(height * 0.4),
      width: Math.round(width * 0.3),
      height: Math.round(height * 0.15),
    };
    const { channels } = await image.clone().extract(box).stats();
    const fill = `#${channels
      .slice(0, 3)
      .map((channel) => hex(channel.mean))
      .join("")}`;
    return new Uint8Array(
      await image
        .composite([
          patch(
            width,
            height,
            `x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}"`,
            fill,
          ),
        ])
        .png()
        .toBuffer(),
    );
  }
  const { data } = await image
    .clone()
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const background = `#${[0, 1, 2].map((index) => hex(data[index] ?? 255)).join("")}`;
  const left = Math.round(width * 0.6);
  return new Uint8Array(
    await image
      .composite([
        patch(
          width,
          height,
          `x="${left}" y="0" width="${width - left}" height="${height}"`,
          background,
        ),
      ])
      .png()
      .toBuffer(),
  );
};
