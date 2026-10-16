/** A location fixture with four zones and two grades (v2 slices 23-24 tests and harness). */
export const OFFICE_LOCATION = {
  id: "office_a",
  name: "Escritório da Bia",
  plate: { assetId: "plate-office", overscan: 2.2 },
  proceduralFallback: "office",
  zones: [
    {
      id: "desk",
      crop: { cx: 0.35, cy: 0.55, zoom: 1.1 },
      allowedShots: ["medium", "close", "two_shot"],
      maxActors: 2,
    },
    {
      id: "window",
      crop: { cx: 0.7, cy: 0.45, zoom: 1.25 },
      allowedShots: ["medium", "close"],
      maxActors: 1,
    },
    {
      id: "door",
      crop: { cx: 0.15, cy: 0.5, zoom: 1 },
      allowedShots: ["wide", "establishing"],
      maxActors: 3,
    },
    {
      id: "overview",
      crop: { cx: 0.5, cy: 0.5, zoom: 1 },
      allowedShots: ["wide", "establishing"],
      maxActors: 3,
    },
  ],
  anchors: [
    { id: "desk_left", x: 0.28, facing: "right" },
    { id: "desk_right", x: 0.72, facing: "left" },
  ],
  lighting: {
    night: { tint: "#1d2a5a", tintAlpha: 0.45, shadowAlpha: 0.3, vignette: 0.3 },
    indoor_warm: { tint: "#ffb347", tintAlpha: 0.18, shadowAlpha: 0.2, vignette: 0.16 },
  },
} as const;
