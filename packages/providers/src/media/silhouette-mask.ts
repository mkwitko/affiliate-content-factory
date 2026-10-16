import sharp from "sharp";
import {
  SILHOUETTE_POSES,
  SILHOUETTE_SIZE,
  type SilhouetteMask,
  silhouetteSvg,
} from "@money-maker/core/explainer/silhouette";
import type { ExplainerCharacter } from "@money-maker/core/explainer/explainer-context";

/** A silhouette SVG rasterised to the 64x96 test mask (dark pixels = figure). */
export const silhouetteMask = async (svg: string): Promise<SilhouetteMask> => {
  const data = await sharp(Buffer.from(svg), { density: 72 })
    .resize(SILHOUETTE_SIZE.width, SILHOUETTE_SIZE.height, { fit: "fill" })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) mask[i] = (data[i] ?? 255) < 128 ? 1 : 0;
  return { ...SILHOUETTE_SIZE, data: mask };
};

/** Masks for every character, in SILHOUETTE_POSES order. */
export const castSilhouettes = async (
  cast: readonly ExplainerCharacter[],
): Promise<ReadonlyMap<string, readonly SilhouetteMask[]>> =>
  new Map(
    await Promise.all(
      cast.map(
        async (character) =>
          [
            character.key,
            await Promise.all(
              SILHOUETTE_POSES.map((pose) => silhouetteMask(silhouetteSvg(character, pose))),
            ),
          ] as const,
      ),
    ),
  );
