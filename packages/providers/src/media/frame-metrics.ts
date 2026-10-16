import { geometryFor } from "@money-maker/core/explainer/layout";
import type { MotionPlan } from "@money-maker/core/explainer/motion/plan";
import {
  type FrameMetrics,
  frameFindings,
  frameVariants,
  keyFrameMs,
  stripFindings,
} from "@money-maker/core/explainer/visual-qa/frame-findings";
import {
  planFindings,
  sceneSpecFindings,
  textBoxesAt,
} from "@money-maker/core/explainer/visual-qa/scene-graph";
import type { VisualFinding, VisualSection } from "@money-maker/core/publishing/render-quality";
import sharp from "sharp";
import { measureFocalContrast } from "./plate-postprocess.js";
import { measureFrames } from "./style-frame-metrics.js";

/**
 * Raster checks of the visual QA pack (v2 slice 28): key frames are rasterised three ways (as
 * viewers see them, without actors, bare of text), downscaled to the 160x284 thumbnail and
 * measured there. Decisions live in core (`frameFindings`); this file only reads pixels.
 */
const THUMBS = Object.freeze({
  portrait: Object.freeze({ width: 160, height: 284 }),
  landscape: Object.freeze({ width: 284, height: 160 }),
});
const MASK_THRESHOLD = 24;

const thumbPng = async (
  svg: string,
  thumb: { width: number; height: number },
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(Buffer.from(svg), { density: 72 })
      .resize(thumb.width, thumb.height, { fit: "fill" })
      .png()
      .toBuffer(),
  );
const raw = async (png: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await sharp(Buffer.from(png)).removeAlpha().raw().toBuffer());
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

export const measureFrame = async (
  plan: MotionPlan,
  sceneIndex: number,
  t: number,
): Promise<FrameMetrics> => {
  const geo = geometryFor(plan.canvas);
  const THUMB = THUMBS[geo.canvas];
  const SCALE = THUMB.width / geo.frame.width;
  const variants = frameVariants(plan, sceneIndex, t);
  const [fullPng, noActorsPng, barePng] = await Promise.all([
    thumbPng(variants.full, THUMB),
    thumbPng(variants.noActors, THUMB),
    thumbPng(variants.bare, THUMB),
  ]);
  const [full, noActors, bare] = await Promise.all([raw(fullPng), raw(noActorsPng), raw(barePng)]);
  const { width, height } = THUMB;
  const mask = new Uint8Array(width * height);
  let maskPx = 0;
  let cx = 0;
  let cy = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 3;
    r += full[i] ?? 0;
    g += full[i + 1] ?? 0;
    b += full[i + 2] ?? 0;
    const d =
      Math.abs((full[i] ?? 0) - (noActors[i] ?? 0)) +
      Math.abs((full[i + 1] ?? 0) - (noActors[i + 1] ?? 0)) +
      Math.abs((full[i + 2] ?? 0) - (noActors[i + 2] ?? 0));
    if (d > MASK_THRESHOLD) {
      mask[p] = 1;
      maskPx += 1;
      cx += p % width;
      cy += Math.floor(p / width);
    }
  }
  const texts = textBoxesAt(plan, sceneIndex, t).map((text) => {
    const x0 = Math.max(0, Math.floor(text.box.left * SCALE));
    const x1 = Math.min(width, Math.ceil(text.box.right * SCALE));
    const y0 = Math.max(0, Math.floor((text.box.top * height) / geo.frame.height));
    const y1 = Math.min(height, Math.ceil((text.box.bottom * height) / geo.frame.height));
    let covered = 0;
    let n = 0;
    let br = 0;
    let bg = 0;
    let bb = 0;
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1) {
        const p = y * width + x;
        covered += mask[p] ?? 0;
        br += bare[p * 3] ?? 0;
        bg += bare[p * 3 + 1] ?? 0;
        bb += bare[p * 3 + 2] ?? 0;
        n += 1;
      }
    return {
      text,
      actorOverlap: n === 0 ? 0 : round(covered / n),
      bgHex: n === 0 ? "#808080" : hex(br / n, bg / n, bb / n),
    };
  });
  const accent = plan.visualLanguage?.palette.roles.accent ?? plan.palette.accent;
  const palette = await measureFrames([fullPng], accent);
  const focal =
    maskPx === 0
      ? null
      : (await measureFocalContrast(fullPng, noActorsPng, Math.round(24 * SCALE))).contrast;
  return {
    actorAreaPct: round((maskPx / (width * height)) * 100, 1),
    actorCentroid:
      maskPx === 0 ? null : { x: round(cx / maskPx / width), y: round(cy / maskPx / height) },
    focalContrast: focal,
    accentShare: palette.accentArea,
    valueTiers: palette.valueTiers,
    dominantArea: palette.dominantArea,
    secondaryArea: palette.secondaryArea,
    meanHex: hex(r / (width * height), g / (width * height), b / (width * height)),
    texts,
  };
};

export interface VisualQa {
  /** Findings for the hook frame and the timeline, before the full render starts. */
  thumbnail(plan: MotionPlan): Promise<readonly VisualFinding[]>;
  /** Every scene's key frame plus scene-graph checks and the colour strip (WARN data only). */
  report(plan: MotionPlan): Promise<VisualSection>;
}

const characterKeys = (plan: MotionPlan) => [
  ...new Set(plan.scenes.flatMap((scene) => scene.actors.map((entry) => entry.character.key))),
];

export const createVisualQa = (): VisualQa => ({
  async thumbnail(plan) {
    const first = plan.scenes[0];
    if (!first) return [];
    const metrics = await measureFrame(plan, 0, keyFrameMs(plan, 0));
    return [
      ...planFindings(plan),
      ...sceneSpecFindings({
        scenes: [first.spec],
        characterKeys: characterKeys(plan),
        canvas: plan.canvas,
      }),
      ...frameFindings({ metrics, plan, sceneIndex: 0, hook: true }),
    ];
  },
  async report(plan) {
    const keys = characterKeys(plan);
    const findings: VisualFinding[] = [
      ...planFindings(plan),
      ...sceneSpecFindings({
        scenes: plan.scenes.map((scene) => scene.spec),
        characterKeys: keys,
        canvas: plan.canvas,
      }),
    ];
    const colorStrip: string[] = [];
    for (let i = 0; i < plan.scenes.length; i += 1) {
      const metrics = await measureFrame(plan, i, keyFrameMs(plan, i));
      colorStrip.push(metrics.meanHex);
      findings.push(...frameFindings({ metrics, plan, sceneIndex: i, hook: i === 0 }));
    }
    findings.push(...stripFindings(colorStrip));
    return { findings, colorStrip };
  },
});
