import sharp from "sharp";

/**
 * Real-composite scene (Phase 3): the product cut-out (RGBA PNG, the listing photo's own pixels)
 * is placed on a drawn backdrop with a contact shadow, so a count-critical product keeps its
 * real parts instead of being redrawn. Furniture stands on the floor line of the lower half;
 * a small item sits a little higher, as on a counter.
 */
export const COMPOSITE_PLACEMENT = {
  floor: { height: 0.58, bottom: 0.9 },
  counter: { height: 0.42, bottom: 0.74 },
  maxWidth: 0.8,
} as const;

export const compositeProduct = async (
  scene: Uint8Array,
  cutout: Uint8Array,
  options: Readonly<{ floor: boolean }>,
): Promise<Uint8Array> => {
  const [backdrop, product] = await Promise.all([
    sharp(scene).metadata(),
    sharp(cutout).metadata(),
  ]);
  const width = backdrop.width ?? 0;
  const height = backdrop.height ?? 0;
  const pw = product.width ?? 0;
  const ph = product.height ?? 0;
  if (!width || !height || !pw || !ph) throw new Error("composite_size_unreadable");
  const place = options.floor ? COMPOSITE_PLACEMENT.floor : COMPOSITE_PLACEMENT.counter;
  const scale = Math.min((height * place.height) / ph, (width * COMPOSITE_PLACEMENT.maxWidth) / pw);
  const w = Math.max(1, Math.round(pw * scale));
  const h = Math.max(1, Math.round(ph * scale));
  const x = Math.round((width - w) / 2);
  const bottom = Math.round(height * place.bottom);
  const y = bottom - h;
  const resized = await sharp(cutout).resize(w, h, { fit: "fill" }).png().toBuffer();
  // Contact shadow: a blurred ellipse under the base, plus a soft drop shadow of the silhouette.
  const shadow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.round(w * 0.06)}"/></filter></defs><ellipse cx="${x + w / 2}" cy="${bottom - Math.round(h * 0.02)}" rx="${Math.round(w * 0.52)}" ry="${Math.round(w * 0.07)}" fill="#000" fill-opacity=".38" filter="url(#b)"/></svg>`,
  );
  const silhouette = await sharp(resized)
    .ensureAlpha()
    .extractChannel("alpha")
    .toColourspace("b-w")
    .blur(Math.max(1, Math.round(w * 0.02)))
    .linear(0.3, 0)
    .toBuffer();
  const drop = await sharp({ create: { width: w, height: h, channels: 3, background: "#000" } })
    .joinChannel(silhouette)
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp(scene)
      .composite([
        { input: shadow, top: 0, left: 0 },
        { input: drop, top: y + Math.round(h * 0.015), left: x },
        { input: resized, top: y, left: x },
      ])
      .png()
      .toBuffer(),
  );
};
