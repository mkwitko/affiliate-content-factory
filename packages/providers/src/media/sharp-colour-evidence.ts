import {
  type ColourEvidence,
  IN_SCENE_FIDELITY_THRESHOLDS as T,
} from "@money-maker/core/creatives/in-scene-fidelity";
import sharp from "sharp";

const SIDE = 96;
type Rgb = readonly [number, number, number];

const raw = async (png: Uint8Array) => {
  const { data, info } = await sharp(png)
    .resize(SIDE, SIDE, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, pixels: info.width * info.height };
};

type Bucket = { n: number; r: number; g: number; b: number };
const near = (data: Buffer, i: number, colour: Rgb) =>
  Math.hypot(
    (data[i * 4] as number) - colour[0],
    (data[i * 4 + 1] as number) - colour[1],
    (data[i * 4 + 2] as number) - colour[2],
  ) <= T.colourDistance;

/** Top colour buckets (4 bits per channel) of the pixels `keep` accepts, with their share. */
/** `bits` per channel: 4 for the calibrated fidelity evidence, coarser for prompt colours. */
const dominant = (
  ref: { data: Buffer; pixels: number },
  keep: (i: number) => boolean,
  bits = 4,
) => {
  const shift = 8 - bits;
  const buckets = new Map<number, Bucket>();
  let counted = 0;
  for (let i = 0; i < ref.pixels; i++) {
    if (!keep(i)) continue;
    const [r, g, b] = [ref.data[i * 4], ref.data[i * 4 + 1], ref.data[i * 4 + 2]] as [
      number,
      number,
      number,
    ];
    counted++;
    const key = ((r >> shift) << (2 * bits)) | ((g >> shift) << bits) | (b >> shift);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  if (counted === 0) return [];
  return [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, T.dominantColours)
    .filter((bucket) => bucket.n / counted >= T.dominantMinShare)
    .map((bucket) => ({
      share: bucket.n / counted,
      mean: [bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n] as Rgb,
    }));
};
const opaque = (data: Buffer) => (i: number) => (data[i * 4 + 3] as number) >= 128;

/**
 * Dominant colours of the reference (transparent pixels ignored; 4 bits per channel buckets) and
 * the share of scene pixels within `colourDistance` of each. Scoring lives in core.
 */
export const colourEvidence = async (
  reference: Uint8Array,
  scene: Uint8Array,
): Promise<ColourEvidence> => {
  const ref = await raw(reference);
  const top = dominant(ref, opaque(ref.data));
  if (top.length === 0) return [];
  const sc = await raw(scene);
  return top.map(({ share, mean }) => {
    let hits = 0;
    for (let i = 0; i < sc.pixels; i++) if (near(sc.data, i, mean)) hits++;
    return { productShare: share, scenePresence: hits / sc.pixels };
  });
};

/**
 * The product's own dominant colours for the scene prompt: transparent pixels and, on an opaque
 * photo, pixels close to the corner (background) colour are ignored.
 */
export const productColours = async (reference: Uint8Array): Promise<readonly Rgb[]> => {
  const ref = await raw(reference);
  const isOpaque = opaque(ref.data);
  const corners = [0, ref.width - 1, ref.pixels - ref.width, ref.pixels - 1];
  const background: Rgb | null = corners.every(isOpaque)
    ? ([0, 1, 2].map(
        (c) => corners.reduce((sum, i) => sum + (ref.data[i * 4 + c] as number), 0) / 4,
      ) as unknown as Rgb)
    : null;
  // 2 bits per channel: shading and a busy photo split a black product over many fine buckets
  // and none reached the minimum share (a black rack measured no colour on 2026-10-08).
  return dominant(ref, (i) => isOpaque(i) && !(background && near(ref.data, i, background)), 2).map(
    (colour) => colour.mean,
  );
};
