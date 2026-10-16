import sharp from "sharp";
import type { Cutout } from "@money-maker/core/creatives/canonical-product";
export type { Cutout } from "@money-maker/core/creatives/canonical-product";

const colorDistance = (data: Buffer, offset: number): number => {
  const red = 255 - (data[offset] ?? 0);
  const green = 255 - (data[offset + 1] ?? 0);
  const blue = 255 - (data[offset + 2] ?? 0);
  return Math.sqrt(red * red + green * green + blue * blue);
};

const pushIfBackground = (
  index: number,
  distances: Float32Array,
  visited: Uint8Array,
  queue: number[],
  threshold: number,
) => {
  if (!visited[index] && (distances[index] ?? Infinity) < threshold) {
    visited[index] = 1;
    queue.push(index);
  }
};

const floodFill = (
  seedIndices: readonly number[],
  width: number,
  height: number,
  distances: Float32Array,
  visited: Uint8Array,
  threshold: number,
): number[] => {
  const queue: number[] = [];
  for (const index of seedIndices) pushIfBackground(index, distances, visited, queue, threshold);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor] ?? 0;
    const x = index % width;
    if (x > 0) pushIfBackground(index - 1, distances, visited, queue, threshold);
    if (x + 1 < width) pushIfBackground(index + 1, distances, visited, queue, threshold);
    if (index >= width) pushIfBackground(index - width, distances, visited, queue, threshold);
    if (index + width < width * height)
      pushIfBackground(index + width, distances, visited, queue, threshold);
  }
  return queue;
};

const borderPixels = (width: number, height: number): number[] => {
  const pixels = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    pixels.add(x);
    pixels.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pixels.add(y * width);
    pixels.add(y * width + width - 1);
  }
  return [...pixels];
};

const collectComponents = (mask: Uint8Array, width: number, height: number) => {
  const visited = new Uint8Array(mask.length);
  let components = 0;
  let largest = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    components += 1;
    const queue = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor] ?? 0;
      const x = index % width;
      const add = (neighbor: number) => {
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      };
      if (x > 0) add(index - 1);
      if (x + 1 < width) add(index + 1);
      if (index >= width) add(index - width);
      if (index + width < width * height) add(index + width);
    }
    largest = Math.max(largest, queue.length);
  }
  return { components, largest };
};

type Decoded = Readonly<{
  rgb: Buffer;
  width: number;
  height: number;
  small: Buffer;
  smallWidth: number;
  smallHeight: number;
  channels: number;
}>;

/** Full-size RGB for the cutout plus a 512-inside copy for mask and QA work, both EXIF-rotated. */
const decode = async (bytes: Uint8Array): Promise<Decoded> => {
  const source = sharp(bytes).rotate();
  const { data: rgb, info: sourceInfo } = await source
    .clone()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: small, info } = await source
    .clone()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgb,
    width: sourceInfo.width,
    height: sourceInfo.height,
    small,
    smallWidth: info.width,
    smallHeight: info.height,
    channels: info.channels,
  };
};

/** Builds the RGBA cutout and its QA metrics from a product mask (1 = product) on the small grid. */
const cutoutFromMask = async (image: Decoded, mask: Uint8Array): Promise<Cutout> => {
  const { rgb, width, height, small: data, smallWidth, smallHeight, channels } = image;
  const total = smallWidth * smallHeight;
  let objectPixels = 0;
  let minX = smallWidth;
  let minY = smallHeight;
  let maxX = -1;
  let maxY = -1;
  let contrastTotal = 0;
  for (let index = 0; index < total; index += 1) {
    if (!mask[index]) continue;
    objectPixels += 1;
    const x = index % smallWidth;
    const y = Math.floor(index / smallWidth);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    contrastTotal += colorDistance(data, index * channels);
  }
  const border = borderPixels(smallWidth, smallHeight);
  const whiteness =
    border.filter((index) => {
      const offset = index * channels;
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      return (
        Math.min(red, green, blue) > 235 &&
        Math.max(red, green, blue) - Math.min(red, green, blue) < 12
      );
    }).length / border.length;
  const { components, largest } = collectComponents(mask, smallWidth, smallHeight);
  const alphaSmall = await sharp(Buffer.from(mask.map((value) => (value ? 255 : 0))), {
    raw: { width: smallWidth, height: smallHeight, channels: 1 },
  })
    .resize(width, height, { kernel: "lanczos3" })
    .blur(0.8)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = rgb[pixel * 3] ?? 0;
    rgba[pixel * 4 + 1] = rgb[pixel * 3 + 1] ?? 0;
    rgba[pixel * 4 + 2] = rgb[pixel * 3 + 2] ?? 0;
    rgba[pixel * 4 + 3] = alphaSmall[pixel] ?? 0;
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return {
    png: new Uint8Array(png),
    width,
    height,
    metrics: {
      coverage: objectPixels / total,
      margin:
        maxX < 0
          ? 0
          : Math.min(minX, minY, smallWidth - 1 - maxX, smallHeight - 1 - maxY) /
            Math.min(smallWidth, smallHeight),
      components,
      largestRatio: objectPixels ? largest / objectPixels : 0,
      whiteness,
      contrast: objectPixels ? contrastTotal / objectPixels : 0,
    },
  };
};

export const removeWhiteBackground = async (bytes: Uint8Array): Promise<Cutout> => {
  const image = await decode(bytes);
  const { small: data, smallWidth, smallHeight, channels } = image;
  const total = smallWidth * smallHeight;
  const distances = new Float32Array(total);
  for (let index = 0; index < total; index += 1)
    distances[index] = colorDistance(data, index * channels);

  const background = new Uint8Array(total);
  floodFill(
    borderPixels(smallWidth, smallHeight),
    smallWidth,
    smallHeight,
    distances,
    background,
    40,
  );
  const holes = new Uint8Array(total);
  const holeMinArea = total * 0.002;
  for (let index = 0; index < total; index += 1) {
    if (background[index] || holes[index] || (distances[index] ?? Infinity) >= 14) continue;
    const component = floodFill([index], smallWidth, smallHeight, distances, holes, 14);
    if (component.length >= holeMinArea) for (const pixel of component) background[pixel] = 1;
  }
  return cutoutFromMask(
    image,
    background.map((value) => (value ? 0 : 1)),
  );
};

/**
 * Cuts the photo's own pixels with an external greyscale mask (white = product, any size; it is
 * resized onto the photo). Same RGBA output and QA metrics as the white-background cutout.
 */
export const applyMask = async (bytes: Uint8Array, maskPng: Uint8Array): Promise<Cutout> => {
  const image = await decode(bytes);
  const values = await sharp(maskPng)
    .removeAlpha()
    .toColourspace("b-w")
    .resize(image.smallWidth, image.smallHeight, { fit: "fill" })
    .raw()
    .toBuffer();
  return cutoutFromMask(
    image,
    new Uint8Array(image.smallWidth * image.smallHeight).map((_, index) =>
      (values[index] ?? 0) >= 128 ? 1 : 0,
    ),
  );
};
