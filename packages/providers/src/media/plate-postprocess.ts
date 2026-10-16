import sharp from "sharp";
import { oklab, type PlatePostProcessPlan } from "@money-maker/core/explainer/compositing";

/**
 * Executes a core PlatePostProcessPlan on a painted plate at import (v2 slice 14): chroma cap,
 * value compression inside the actor halo band (feathered), far value pull toward the palette
 * surface and an optional baked blur. Every step is measured and recorded so the asset says what
 * was done; a plate under 512 px is returned untouched.
 */
export type PlatePostProcessRecord = Readonly<{
  compositingVersion: 1;
  skipped?: "too_small" | undefined;
  meanChromaBefore: number;
  saturationScale: number;
  haloStdBefore: number;
  haloContrastScale: number;
  farValuePull: number;
  blurSigma: number;
}>;

const MIN_PX = 512;
const SAMPLE = 96;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

type Stats = Readonly<{ meanChroma: number; bandStd: number; bandMeanRgb: number }>;

/** OKLab statistics on a small sample: overall mean chroma, L spread and mean luma in the band. */
const measure = async (
  bytes: Buffer,
  band: Readonly<{ top: number; bottom: number }>,
): Promise<Stats> => {
  const { data, info } = await sharp(bytes)
    .resize(SAMPLE, SAMPLE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let chroma = 0;
  const bandL: number[] = [];
  let bandRgb = 0;
  const top = Math.floor(band.top * info.height);
  const bottom = Math.ceil(band.bottom * info.height);
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const [l, a, bb] = oklab(r, g, b);
      chroma += Math.hypot(a, bb);
      if (y >= top && y < bottom) {
        bandL.push(l);
        bandRgb += (r + g + b) / 3;
      }
    }
  const mean = bandL.reduce((sum, v) => sum + v, 0) / Math.max(1, bandL.length);
  const variance = bandL.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, bandL.length);
  return {
    meanChroma: chroma / (info.width * info.height),
    bandStd: Math.sqrt(variance),
    bandMeanRgb: bandRgb / Math.max(1, bandL.length),
  };
};

const hexRgb = (hex: string): readonly [number, number, number] => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A vertical alpha ramp: 0 outside the band, 255 inside, feathered over `feather` px. */
const bandMask = (width: number, height: number, top: number, bottom: number, feather: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="${height}" gradientUnits="userSpaceOnUse"><stop offset="${Math.max(0, top - feather) / height}" stop-color="#fff" stop-opacity="0"/><stop offset="${top / height}" stop-color="#fff" stop-opacity="1"/><stop offset="${bottom / height}" stop-color="#fff" stop-opacity="1"/><stop offset="${Math.min(height, bottom + feather) / height}" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/></svg>`,
  );

export const postProcessPlate = async (
  input: Uint8Array,
  plan: PlatePostProcessPlan,
): Promise<
  Readonly<{ bytes: Uint8Array; mimeType: "image/jpeg"; record: PlatePostProcessRecord }>
> => {
  const source = Buffer.from(input);
  const meta = await sharp(source).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const before = await measure(source, plan.haloBand);
  const base = {
    compositingVersion: 1 as const,
    meanChromaBefore: round4(before.meanChroma),
    haloStdBefore: round4(before.bandStd),
    farValuePull: plan.farValuePull,
    blurSigma: plan.blurSigma,
  };
  if (width < MIN_PX || height < MIN_PX)
    return {
      bytes: new Uint8Array(await sharp(source).jpeg({ quality: 92 }).toBuffer()),
      mimeType: "image/jpeg",
      record: { ...base, skipped: "too_small", saturationScale: 1, haloContrastScale: 1 },
    };
  const saturationScale =
    before.meanChroma > plan.maxMeanChroma && before.meanChroma > 0
      ? plan.maxMeanChroma / before.meanChroma
      : 1;
  let image = await sharp(source)
    .removeAlpha()
    .modulate({ saturation: saturationScale })
    .toBuffer();
  const haloContrastScale =
    before.bandStd > plan.haloStdMax && before.bandStd > 0 ? plan.haloStdMax / before.bandStd : 1;
  if (haloContrastScale < 1) {
    const top = Math.round(plan.haloBand.top * height);
    const bottom = Math.round(plan.haloBand.bottom * height);
    const offset = before.bandMeanRgb * (1 - haloContrastScale);
    const compressed = await sharp(image).linear(haloContrastScale, offset).toBuffer();
    const alpha = await sharp(bandMask(width, height, top, bottom, Math.round(height * 0.06)))
      .extractChannel("alpha")
      .toBuffer();
    const layered = await sharp(compressed).joinChannel(alpha).png().toBuffer();
    image = await sharp(image)
      .composite([{ input: layered }])
      .toBuffer();
  }
  if (plan.farValuePull > 0) {
    const target = hexRgb(plan.pullTarget);
    const keep = 1 - plan.farValuePull;
    image = await sharp(image)
      .linear(
        [keep, keep, keep],
        target.map((c) => c * plan.farValuePull),
      )
      .toBuffer();
  }
  if (plan.blurSigma >= 0.3) image = await sharp(image).blur(plan.blurSigma).toBuffer();
  return {
    bytes: new Uint8Array(await sharp(image).jpeg({ quality: 92 }).toBuffer()),
    mimeType: "image/jpeg",
    record: {
      ...base,
      saturationScale: round4(saturationScale),
      haloContrastScale: round4(haloContrastScale),
    },
  };
};

/**
 * Figure-ground contrast (spec 10.3 focalContrastTarget): |mean OKLab L inside the actor mask −
 * mean L in a ring around it|. The mask is where two renders of the same frame differ (with and
 * without actors), so no composer change is needed to get it.
 */
export const measureFocalContrast = async (
  withActors: Uint8Array,
  withoutActors: Uint8Array,
  ringPx = 24,
): Promise<Readonly<{ contrast: number; maskPx: number; ringPx: number }>> => {
  const read = async (bytes: Uint8Array) =>
    sharp(Buffer.from(bytes)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const a = await read(withActors);
  const b = await read(withoutActors);
  const { width, height } = a.info;
  if (width !== b.info.width || height !== b.info.height) throw new Error("focal_contrast_size");
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 3;
    const d =
      Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
      Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
      Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (d > 24) mask[p] = 1;
  }
  // Ring: a box dilation of the mask (separable max over ringPx) minus the mask itself.
  const dilate = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        let hit = 0;
        for (let k = -ringPx; k <= ringPx && !hit; k += 1) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx >= 0 && xx < width && yy >= 0 && yy < height) hit = src[yy * width + xx] ?? 0;
        }
        out[y * width + x] = hit;
      }
    return out;
  };
  const grown = dilate(dilate(mask, true), false);
  let inL = 0;
  let inN = 0;
  let ringL = 0;
  let ringN = 0;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 3;
    const [l] = oklab(a.data[i] ?? 0, a.data[i + 1] ?? 0, a.data[i + 2] ?? 0);
    if (mask[p]) {
      inL += l;
      inN += 1;
    } else if (grown[p]) {
      ringL += l;
      ringN += 1;
    }
  }
  if (inN === 0 || ringN === 0) return { contrast: 0, maskPx: inN, ringPx: ringN };
  return { contrast: round4(Math.abs(inL / inN - ringL / ringN)), maskPx: inN, ringPx: ringN };
};
