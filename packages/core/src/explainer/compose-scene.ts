import { PROP_SHOT_SCALE, SHOT_SCALE } from "./shots.js";
import { renderBackground } from "./backgrounds.js";
import { renderDiagram } from "./diagrams.js";
import type { ExplainerCharacter } from "./explainer-context.js";
import {
  type Canvas,
  type CanvasGeometry,
  escapeXml,
  fitFontSize,
  geometryFor,
  PORTRAIT_GEOMETRY,
  positionX,
} from "./layout.js";
import { renderProp } from "./props.js";
import { renderStickman } from "./rigs/stick-v1.js";
import type { SceneSpec } from "./scene-spec.js";

export type SceneComposePalette = Readonly<{
  surface: string;
  muted: string;
  accent: string;
  text: string;
  line: string;
}>;
export type SceneComposeContext = Readonly<{
  characters: readonly ExplainerCharacter[];
  palette: SceneComposePalette;
  /** Absent means portrait. */
  canvas?: Canvas | undefined;
}>;

/** Portrait overlay baselines: both sit above the caption band (y >= 1000). */
export const OVERLAY_Y = PORTRAIT_GEOMETRY.overlayY;
/** Characters step back (smaller) when a diagram holds the centre of the frame. */
const DIAGRAM_ACTOR_SCALE = 0.55;
/** At 1.3x the rig (about 550 px with raised arms) still clears SAFE_BOX.top from the baseline. */
const MAX_ACTOR_SCALE = 1.3;
const shotScale = (shot: SceneSpec["camera"]["shot"]): number => SHOT_SCALE[shot];

/** Stage layout shared by stills and motion frames, so both place things identically. */
export const actorScaleFor = (scene: SceneSpec, actor: SceneSpec["actors"][number]): number =>
  Math.min(
    MAX_ACTOR_SCALE,
    shotScale(scene.camera.shot) * (scene.diagram ? DIAGRAM_ACTOR_SCALE : 1) * (actor.scale ?? 1),
  );
export const propAnchor = (
  prop: SceneSpec["props"][number],
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): Readonly<{ x: number; y: number }> => ({
  x: positionX(prop.position === "top" ? "center" : prop.position, geometry),
  y: prop.position === "top" ? geometry.propY.top : geometry.propY.stage,
});
export const propScaleFor = (scene: SceneSpec): number => PROP_SHOT_SCALE[scene.camera.shot];
export const overlayFontSize = (
  overlay: SceneSpec["overlays"][number],
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): number => fitFontSize(overlay.text, overlay.emphasis ? 92 : 68, geometry.overlayFitWidth);

/** Composes one scene (1080x1920, or 1920x1080 landscape) as a standalone SVG; pure and deterministic. */
export const composeSceneSvg = (scene: SceneSpec, context: SceneComposeContext): string => {
  const geo = geometryFor(context.canvas);
  const { frame } = geo;
  const byKey = new Map(context.characters.map((character) => [character.key, character]));
  const layers: string[] = [renderBackground(scene.background, context.palette, geo)];
  if (scene.diagram) layers.push(renderDiagram(scene.diagram, context.palette, 1, geo));
  for (const prop of scene.props)
    layers.push(
      renderProp({
        type: prop.type,
        ...propAnchor(prop, geo),
        scale: propScaleFor(scene),
        label: prop.label,
        palette: { line: context.palette.line, accent: context.palette.accent },
      }),
    );
  for (const actor of scene.actors) {
    const character = byKey.get(actor.characterKey);
    if (!character) throw new Error(`scene_character_missing:${scene.index}`);
    layers.push(
      renderStickman({
        pose: actor.pose,
        expression: actor.expression,
        palette: character.palette,
        x: positionX(actor.position, geo),
        baselineY: geo.baselineY,
        scale: actorScaleFor(scene, actor),
        facing: actor.facing,
        accessory: character.accessory,
        wardrobe: character.wardrobe,
      }),
    );
  }
  for (const overlay of scene.overlays) {
    const size = overlayFontSize(overlay, geo);
    layers.push(
      `<text data-overlay="1" x="${geo.overlayStillCx}" y="${geo.overlayY[overlay.position]}" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="${size}" fill="${context.palette.text}" stroke="${context.palette.surface}" stroke-width="12" paint-order="stroke" stroke-linejoin="round">${escapeXml(overlay.text)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">${layers.join("")}</svg>`;
};
