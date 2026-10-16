import type { VisualFinding } from "../../publishing/render-quality.js";
import { BACKGROUNDS } from "../backgrounds.js";
import { actorScaleFor, overlayFontSize } from "../compose-scene.js";
import {
  type Canvas,
  type CanvasGeometry,
  fitFontSize,
  geometryFor,
  PORTRAIT_GEOMETRY,
  positionX,
} from "../layout.js";
import { wordWidth } from "../motion/frame.js";
import { type MotionPlan, TRANSITION_MS } from "../motion/plan.js";
import { EXPRESSIONS, HEAD_TOP_Y, POSES } from "../rigs/stick-v1.js";
import type { SceneSpec } from "../scene-spec.js";
import { finding, VISUAL_QA_TUNABLES as T } from "./tunables.js";

export type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type TextBox = Readonly<{ kind: "overlay" | "caption"; box: Box; sizePx: number }>;

const area = (box: Box) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});

/** Share of a box that lies outside the frame (0..1). */
export const cropFraction = (box: Box, geo: CanvasGeometry = PORTRAIT_GEOMETRY): number =>
  area(box) === 0
    ? 0
    : 1 -
      area(intersect(box, { left: 0, top: 0, right: geo.frame.width, bottom: geo.frame.height })) /
        area(box);

/** True when a text box crosses the canvas safe box by more than the slack. */
export const outsideSafeBox = (box: Box, geo: CanvasGeometry = PORTRAIT_GEOMETRY): boolean =>
  box.left < geo.safeBox.left - T.safeBoxSlackPx ||
  box.right > geo.safeBox.right + T.safeBoxSlackPx ||
  box.top < geo.safeBox.top - T.safeBoxSlackPx ||
  box.bottom > geo.safeBox.bottom + T.safeBoxSlackPx;

/** Estimated silhouette box of a scene actor at rest (feet on the baseline). */
export const actorBox = (
  scene: SceneSpec,
  actor: SceneSpec["actors"][number],
  geo: CanvasGeometry = PORTRAIT_GEOMETRY,
): Box => {
  const height = -HEAD_TOP_Y * actorScaleFor(scene, actor);
  const half = height * T.actorHalfWidthPerHeight;
  const x = positionX(actor.position, geo);
  return { left: x - half, right: x + half, top: geo.baselineY - height, bottom: geo.baselineY };
};

/** Estimated text extents of a scene overlay as slam() lays it out (centred on the frame). */
export const overlayBox = (
  overlay: SceneSpec["overlays"][number],
  geo: CanvasGeometry = PORTRAIT_GEOMETRY,
): TextBox => {
  const sizePx = overlayFontSize(overlay, geo);
  const words = overlay.text.trim().split(/\s+/);
  const width =
    words.reduce((sum, word) => sum + wordWidth(word, sizePx), 0) +
    sizePx * 0.3 * (words.length - 1);
  const y = geo.overlayY[overlay.position];
  return {
    kind: "overlay",
    sizePx,
    box: {
      left: geo.frame.width / 2 - width / 2,
      right: geo.frame.width / 2 + width / 2,
      top: y - sizePx * 0.8,
      bottom: y + sizePx * 0.25,
    },
  };
};

/** Estimated text extents of a caption group as drawCaptions() sizes it. */
export const captionBox = (plan: MotionPlan, text: string): TextBox => {
  const geo = geometryFor(plan.canvas);
  const sizePx = fitFontSize(
    text,
    plan.visualLanguage?.type.captionPx[1] ?? 64,
    geo.captionFitWidth,
  );
  const width = wordWidth(text, sizePx);
  const cy = (geo.captionBand.top + geo.captionBand.bottom) / 2;
  return {
    kind: "caption",
    sizePx,
    box: {
      left: geo.frame.width / 2 - width / 2,
      right: geo.frame.width / 2 + width / 2,
      top: cy - sizePx * 0.6,
      bottom: cy + sizePx * 0.4,
    },
  };
};

/** Text that is on screen in a planned scene at time t. */
export const textBoxesAt = (
  plan: MotionPlan,
  sceneIndex: number,
  t: number,
): readonly TextBox[] => {
  const scene = plan.scenes[sceneIndex];
  if (!scene) return [];
  const boxes = scene.overlays
    .filter((entry) => t >= entry.atMs)
    .map((entry) => overlayBox(entry.overlay, geometryFor(plan.canvas)));
  const group = scene.captions.find((entry) => t >= entry.startMs && t < entry.endMs);
  if (group?.words.length)
    boxes.push(captionBox(plan, group.words.map((word) => word.text).join(" ")));
  return boxes;
};

export const captionColours = (plan: MotionPlan): Readonly<{ textOn: string; plate: string }> => ({
  textOn: plan.visualLanguage?.palette.roles.textOn ?? "#ffffff",
  plate: plan.visualLanguage?.palette.roles.textPlate ?? plan.palette.line,
});

const moves = (actor: SceneSpec["actors"][number]) =>
  actor.actions?.some((a) => a.type === "enter" || a.type === "exit" || a.type === "walk_to") ??
  false;

/**
 * Checks that need only the storyboard (no timing, no pixels): safe rect, crop, catalog ids,
 * estimated actor/text overlap (WARN: the raster check owns the BLOCK) and repeated composition.
 */
export const sceneSpecFindings = (input: {
  scenes: readonly SceneSpec[];
  characterKeys: readonly string[];
  /** Absent means portrait. */
  canvas?: Canvas | undefined;
}): readonly VisualFinding[] => {
  const geo = geometryFor(input.canvas);
  const out: VisualFinding[] = [];
  const keys = new Set(input.characterKeys);
  const backgrounds: readonly string[] = BACKGROUNDS;
  const poses: readonly string[] = POSES;
  const expressions: readonly string[] = EXPRESSIONS;
  for (const scene of input.scenes) {
    const at = scene.index;
    const boxes = scene.overlays.map((overlay) => overlayBox(overlay, geo));
    if (boxes.some((entry) => outsideSafeBox(entry.box, geo)))
      out.push(finding("text_outside_safe_box", "BLOCK", at));
    const bodies = scene.actors
      .filter((actor) => !moves(actor))
      .map((actor) => actorBox(scene, actor, geo));
    if (bodies.some((box) => cropFraction(box, geo) > T.cropBlockFraction))
      out.push(finding("actor_cropped", "BLOCK", at));
    const overlap = boxes.some((entry) =>
      bodies.some(
        (body) => area(intersect(entry.box, body)) > T.collisionBlockFraction * area(entry.box),
      ),
    );
    if (overlap) out.push(finding("actor_text_overlap_estimate", "WARN", at));
    const invalid =
      !backgrounds.includes(scene.background) ||
      scene.actors.some(
        (actor) =>
          !keys.has(actor.characterKey) ||
          !poses.includes(actor.pose) ||
          !expressions.includes(actor.expression),
      );
    if (invalid) out.push(finding("catalog_ref_invalid", "BLOCK", at));
  }
  const signature = (scene: SceneSpec) =>
    JSON.stringify([
      scene.background,
      scene.camera.shot,
      scene.actors.map((a) => [a.characterKey, a.pose, a.position]),
      scene.props.map((p) => [p.type, p.position]),
    ]);
  let run = 1;
  input.scenes.forEach((scene, i) => {
    const previous = input.scenes[i - 1];
    run = previous && signature(previous) === signature(scene) ? run + 1 : 1;
    if (run === T.repetitionRun) out.push(finding("composition_repeated", "WARN", scene.index));
  });
  return out;
};

/** Timeline checks on a planned render: overlap and range (BLOCK), long holds (WARN). */
export const planFindings = (plan: MotionPlan): readonly VisualFinding[] => {
  const out: VisualFinding[] = [];
  plan.scenes.forEach((scene, i) => {
    const previous = plan.scenes[i - 1];
    const invalid =
      scene.startMs < 0 ||
      scene.endMs <= scene.startMs ||
      scene.endMs > plan.durationMs + 1 ||
      (previous !== undefined && scene.startMs < previous.endMs - TRANSITION_MS - 1);
    if (invalid) out.push(finding("timeline_invalid", "BLOCK", scene.spec.index));
    const active =
      scene.actors.some((a) => a.actions.length > 0) ||
      scene.overlays.length > 0 ||
      scene.diagram !== undefined;
    if (
      !active &&
      scene.spec.holdMode !== "intentional_still" &&
      scene.endMs - scene.startMs > T.longHoldSec * 1000
    )
      out.push(finding("long_hold", "WARN", scene.spec.index));
  });
  return out;
};
