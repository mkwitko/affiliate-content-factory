import sharp from "sharp";
import type { BrandKit } from "@money-maker/core/brand/brand-kit";

export const proceduralScene = async (input: {
  width: number;
  height: number;
  palette: BrandKit["palette"];
}): Promise<Uint8Array> => {
  if (
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0
  )
    throw new Error("scene_dimensions_invalid");
  const color = (value: string): string => {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error("scene_palette_invalid");
    return value;
  };
  const primary = color(input.palette.primary);
  const accent = color(input.palette.accent);
  const surface = color(input.palette.surface);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${surface}"/></linearGradient><radialGradient id="light"><stop stop-color="${accent}" stop-opacity=".28"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient><linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${surface}" stop-opacity="0"/><stop offset="1" stop-color="${surface}" stop-opacity=".38"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/><ellipse cx="50%" cy="42%" rx="58%" ry="48%" fill="url(#light)"/><rect y="74%" width="100%" height="26%" fill="url(#floor)"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};
