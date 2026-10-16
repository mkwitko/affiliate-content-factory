/**
 * The show's visual language v1 (v2 slice 18): the owner chose EXPRESSIVE_INK + GOUACHE_PAINTED
 * on 2026-09-30 from the blind style-frame review. Measured with measure-style-frames on the
 * reviewed stills (`style-frames-out-gouache`, byte-identical to the reviewed frames): palette
 * areas, value tiers, figure-ground contrast and hero area. Fields not measured keep today's
 * values, so applying it changes no pixel; the look itself comes from the niche's
 * `explainer.style: "sketch_watercolor"` (spec 10.1 maps it to GOUACHE_PAINTED).
 * Stored form, as sent to update_niche_context under explainer.visualLanguage.
 */
export const GOUACHE_V1 = {
  id: "gouache-v1",
  version: 1,
  characterStyle: "EXPRESSIVE_INK",
  environmentStyle: "GOUACHE_PAINTED",
  palette: { areaMax: { dominant: 0.38, secondary: 0.12, accent: 0.06 } },
  // MEASURED: 7% dark, 14% mid, 79% light pixels over the 20 stills.
  value: { areaTarget: [0.069, 0.14, 0.791], minFocalDeltaL: 0.15 },
  // MEASURED: hero silhouette between 0.94% and 5.54% of the frame (frames 3, 6, 8).
  composition: { heroAreaPct: [0.94, 5.54] },
} as const;
