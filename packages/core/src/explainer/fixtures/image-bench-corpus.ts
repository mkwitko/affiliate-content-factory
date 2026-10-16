/** Fixed prompts for the local image benchmark (D1). No product photos and no brand names. */
export type ImageBenchCase = Readonly<{
  id: string;
  prompt: string;
  width: number;
  height: number;
  seeds: readonly number[];
}>;

const seeds = Object.freeze([1234, 5678, 9012]);
const make = (id: string, width: number, height: number, prompt: string): ImageBenchCase =>
  Object.freeze({ id, prompt, width, height, seeds });

export const IMAGE_BENCH_CORPUS: readonly ImageBenchCase[] = Object.freeze([
  make(
    "illustrated_background",
    1024,
    1024,
    "children's book illustration of a cozy kitchen, flat colors, clean outlines, plain background, no people, no text",
  ),
  make(
    "landscape_location_plate",
    1216,
    832,
    "painted gouache landscape of a quiet shopping street at dusk, warm lamps, wide empty foreground, no people, no text",
  ),
  make(
    "story_world_background",
    896,
    1152,
    "storefront interior with shelves and a wooden counter, soft daylight, illustrated flat style, empty space in the center, no people, no text",
  ),
  make(
    "scene_plate_9x16",
    768,
    1344,
    "empty modern kitchen countertop scene, soft window light, negative space in center, vertical 9:16, no text",
  ),
  make(
    "visual_asset_4x5",
    768,
    960,
    "flat illustrated desk with notebook, coffee cup and plant, pastel colors, generous empty margin, no text",
  ),
  make(
    "youtube_visual_16x9",
    1344,
    768,
    "wide illustrated city skyline with a bright sunrise and soft clouds, clean shapes, no people, no text",
  ),
  make(
    "thumbnail_background",
    1280,
    704,
    "youtube thumbnail background, bold gradient, abstract shapes, no text",
  ),
  make(
    "character_reference",
    768,
    1024,
    "children's book illustration of a cheerful tall woman in a green sweater, full body, front view, flat colors, clean outlines, plain white background",
  ),
]);
