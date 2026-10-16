import sharp from "sharp";
import {
  type FidelityInput,
  type FidelityMeasurer,
  type FidelityMetrics,
  UNMEASURED_FIDELITY,
} from "@money-maker/core/creatives/product-fidelity";

/** Metrics run on aligned crops whose longer side is at most this many pixels. */
const SIDE = 256;
// ponytail: fixed per-pixel agreement tolerance stands in for segmenting the rendered crop;
// replace with an ImageSegmenter pass once segmentation is calibrated (slice 6).
const AGREEMENT_DELTA_E = 10;
const EDGE_THRESHOLD = 80;
const MS_SSIM_WEIGHTS = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333] as const;
const WINDOW = 8;

const toLinear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const labF = (t: number): number =>
  t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;

/** sRGB (0-255) to CIELAB, D65 white. */
export const srgbToLab = (red: number, green: number, blue: number): [number, number, number] => {
  const r = toLinear(red);
  const g = toLinear(green);
  const b = toLinear(blue);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

const deg = (radians: number): number => (radians * 180) / Math.PI;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** CIEDE2000 (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export const deltaE2000 = (
  lab1: readonly [number, number, number],
  lab2: readonly [number, number, number],
): number => {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp / 2));
  const lMean = (l1 + l2) / 2;
  const cMeanP = (c1p + c2p) / 2;
  let hMean = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hMean /= 2;
    else hMean = h1p + h2p < 360 ? (hMean + 360) / 2 : (hMean - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hMean - 30)) +
    0.24 * Math.cos(rad(2 * hMean)) +
    0.32 * Math.cos(rad(3 * hMean + 6)) -
    0.2 * Math.cos(rad(4 * hMean - 63));
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const cMeanP7 = cMeanP ** 7;
  const rc = 2 * Math.sqrt(cMeanP7 / (cMeanP7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMeanP;
  const sh = 1 + 0.015 * cMeanP * t;
  const rt = -Math.sin(rad(2 * dTheta)) * rc;
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
};

type Gray = Readonly<{ data: Float64Array; width: number; height: number }>;

const erode = (mask: Uint8Array, width: number, height: number): Uint8Array => {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      out[i] = mask[i] && mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width] ? 1 : 0;
    }
  return out;
};

const dilate = (mask: Uint8Array, width: number, height: number): Uint8Array => {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
        }
    }
  return out;
};

/** Sobel magnitude above EDGE_THRESHOLD, restricted to `within`. */
const edges = (gray: Gray, within: Uint8Array): Uint8Array => {
  const { data, width, height } = gray;
  const out = new Uint8Array(data.length);
  const at = (x: number, y: number) => data[y * width + x] ?? 0;
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      if (!within[y * width + x]) continue;
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      if (Math.hypot(gx, gy) > EDGE_THRESHOLD) out[y * width + x] = 1;
    }
  return out;
};

const count = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);

const halve = (gray: Gray): Gray => {
  const width = Math.floor(gray.width / 2);
  const height = Math.floor(gray.height / 2);
  const data = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = 2 * y * gray.width + 2 * x;
      data[y * width + x] =
        ((gray.data[i] ?? 0) +
          (gray.data[i + 1] ?? 0) +
          (gray.data[i + gray.width] ?? 0) +
          (gray.data[i + gray.width + 1] ?? 0)) /
        4;
    }
  return { data, width, height };
};

const halveMask = (mask: Uint8Array, width: number, height: number): Uint8Array => {
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = 2 * y * width + 2 * x;
      out[y * w + x] = mask[i] && mask[i + 1] && mask[i + width] && mask[i + width + 1] ? 1 : 0;
    }
  return out;
};

/** Mean SSIM and contrast-structure over 8x8 windows whose centre lies in the mask. */
const ssimAt = (
  a: Gray,
  b: Gray,
  mask: Uint8Array,
): Readonly<{ ssim: number; cs: number }> | null => {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const n = WINDOW * WINDOW;
  let ssimSum = 0;
  let csSum = 0;
  let windows = 0;
  for (let y = 0; y + WINDOW <= a.height; y += 1)
    for (let x = 0; x + WINDOW <= a.width; x += 1) {
      if (!mask[(y + WINDOW / 2) * a.width + x + WINDOW / 2]) continue;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let dy = 0; dy < WINDOW; dy += 1)
        for (let dx = 0; dx < WINDOW; dx += 1) {
          const i = (y + dy) * a.width + x + dx;
          const va = a.data[i] ?? 0;
          const vb = b.data[i] ?? 0;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const cs = (2 * cov + c2) / (va + vb + c2);
      ssimSum += ((2 * ma * mb + c1) / (ma * ma + mb * mb + c1)) * cs;
      csSum += cs;
      windows += 1;
    }
  return windows ? { ssim: ssimSum / windows, cs: csSum / windows } : null;
};

/** MS-SSIM (Wang, Simoncelli, Bovik 2003) on a 2x average pyramid; stops when a scale has no masked window. */
const msSsim = (a: Gray, b: Gray, mask: Uint8Array): number | null => {
  const scales: Array<{ ssim: number; cs: number }> = [];
  let ga = a;
  let gb = b;
  let m = mask;
  for (let s = 0; s < MS_SSIM_WEIGHTS.length; s += 1) {
    if (ga.width < WINDOW || ga.height < WINDOW) break;
    const result = ssimAt(ga, gb, m);
    if (!result) break;
    scales.push(result);
    m = halveMask(m, ga.width, ga.height);
    ga = halve(ga);
    gb = halve(gb);
  }
  if (scales.length === 0) return null;
  const weights = MS_SSIM_WEIGHTS.slice(0, scales.length);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return scales.reduce((product, scale, index) => {
    const value = index === scales.length - 1 ? scale.ssim : scale.cs;
    return product * Math.max(0, value) ** ((weights[index] ?? 0) / total);
  }, 1);
};

const luma = (rgb: Uint8Array, channels: number, pixels: number): Gray["data"] => {
  const out = new Float64Array(pixels);
  for (let p = 0; p < pixels; p += 1)
    out[p] =
      0.299 * (rgb[p * channels] ?? 0) +
      0.587 * (rgb[p * channels + 1] ?? 0) +
      0.114 * (rgb[p * channels + 2] ?? 0);
  return out;
};

/**
 * Measures one aligned product region with sharp raw buffers: agreement IoU, mean CIEDE2000,
 * masked MS-SSIM and Sobel edge recall/excess. Throws fidelity_region_invalid when the region
 * does not fit the render; returns UNMEASURED_FIDELITY when the mask is empty.
 */
export const measureProductFidelity = async (input: FidelityInput): Promise<FidelityMetrics> => {
  const { region } = input;
  const meta = await sharp(input.rendered).metadata();
  if (
    !meta.width ||
    !meta.height ||
    region.w < 1 ||
    region.h < 1 ||
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.w > meta.width ||
    region.y + region.h > meta.height
  )
    throw new Error("fidelity_region_invalid");
  const scale = Math.min(1, SIDE / Math.max(region.w, region.h));
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  const pixels = width * height;
  const reference = await sharp(input.original)
    .ensureAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  const rendered = await sharp(input.rendered)
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  const maskValues = input.mask
    ? await sharp(input.mask)
        .removeAlpha()
        .toColourspace("b-w")
        .resize(width, height, { fit: "fill" })
        .raw()
        .toBuffer()
    : null;
  const mask = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p += 1)
    mask[p] = (maskValues ? (maskValues[p] ?? 0) : (reference[p * 4 + 3] ?? 0)) >= 128 ? 1 : 0;
  const maskArea = count(mask);
  if (maskArea === 0) return UNMEASURED_FIDELITY;
  // The reference as the renderer would composite it: product pixels over the rendered backdrop,
  // so windows and edges that straddle the silhouette compare product, not background.
  const blended = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p += 1) {
    const alpha = (reference[p * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c += 1)
      blended[p * 3 + c] = Math.round(
        alpha * (reference[p * 4 + c] ?? 0) + (1 - alpha) * (rendered[p * 3 + c] ?? 0),
      );
  }
  const eroded = erode(erode(mask, width, height), width, height);
  const interior = count(eroded) > 0 ? eroded : mask;

  // maskIou: share of the expected silhouette whose rendered pixels still match (ΔE00 <= 10).
  // With no segmentation of the rendered crop this equals IoU against the matching pixels.
  let agreeing = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  for (let p = 0; p < pixels; p += 1) {
    if (!mask[p]) continue;
    const delta = deltaE2000(
      srgbToLab(blended[p * 3] ?? 0, blended[p * 3 + 1] ?? 0, blended[p * 3 + 2] ?? 0),
      srgbToLab(rendered[p * 3] ?? 0, rendered[p * 3 + 1] ?? 0, rendered[p * 3 + 2] ?? 0),
    );
    if (delta <= AGREEMENT_DELTA_E) agreeing += 1;
    if (interior[p]) {
      deltaSum += delta;
      deltaCount += 1;
    }
  }
  const grayRef: Gray = { data: luma(blended, 3, pixels), width, height };
  const grayOut: Gray = { data: luma(rendered, 3, pixels), width, height };
  const edgesRef = edges(grayRef, interior);
  const edgesOut = edges(grayOut, interior);
  const nearOut = dilate(edgesOut, width, height);
  const nearRef = dilate(edgesRef, width, height);
  let refEdges = 0;
  let recalled = 0;
  let outEdges = 0;
  let excess = 0;
  for (let p = 0; p < pixels; p += 1) {
    if (edgesRef[p]) {
      refEdges += 1;
      if (nearOut[p]) recalled += 1;
    }
    if (edgesOut[p]) {
      outEdges += 1;
      if (!nearRef[p]) excess += 1;
    }
  }
  return {
    maskIou: agreeing / maskArea,
    deltaE: deltaCount ? deltaSum / deltaCount : null,
    msSsim: msSsim(grayRef, grayOut, interior),
    // A product with no interior edges has no detail to lose.
    edgeRecall: refEdges ? recalled / refEdges : 1,
    edgeExcess: outEdges ? excess / outEdges : 0,
    inventedText: [],
  };
};

export const createSharpFidelityMeasurer = (): FidelityMeasurer => ({
  measure: measureProductFidelity,
});
