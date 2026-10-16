import type { SceneSpec } from "./scene-spec.js";
import { type Canvas, geometryFor, positionX } from "./layout.js";

/**
 * Focus of one stored scene as a fraction of frame width: the narrator (first actor) of a
 * SceneSpec. Slideshow scenes carry no subject position, so they have none.
 */
export const sceneFocusX = (
  scene: SceneSpec | { assetId: string },
  canvas?: Canvas,
): number | undefined => {
  const geo = geometryFor(canvas);
  const first = "actors" in scene ? scene.actors[0] : undefined;
  return first ? positionX(first.position, geo) / geo.frame.width : undefined;
};

export type FocusScene = Readonly<{ startMs: number; endMs: number; focusX?: number | undefined }>;
export type FocusPoint = Readonly<{ tMs: number; x: number }>;

/**
 * Crop-window left edge per scene for a 9:16 window over a landscape source. The window snaps at
 * scene cuts. ponytail: focus is one value per scene (the stored data has no per-frame track), so
 * there is no in-scene pan or dead zone; add them when a per-frame focus source exists.
 * Returns null when no scene has a focus, so the caller falls back to the blurred layout.
 */
export const focusTrack = (input: {
  scenes: readonly FocusScene[];
  sourceWidth: number;
  sourceHeight: number;
}): { cropWidth: number; points: FocusPoint[] } | null => {
  if (!input.scenes.some((scene) => scene.focusX !== undefined)) return null;
  const cropWidth = Math.round((input.sourceHeight * 9) / 16 / 2) * 2;
  const maxX = Math.max(0, input.sourceWidth - cropWidth);
  const points: FocusPoint[] = [];
  for (const scene of input.scenes) {
    const centre = (scene.focusX ?? 0.5) * input.sourceWidth;
    const x = Math.min(maxX, Math.max(0, Math.round(centre - cropWidth / 2)));
    if (points.at(-1)?.x !== x) points.push({ tMs: scene.startMs, x });
  }
  return { cropWidth, points };
};
