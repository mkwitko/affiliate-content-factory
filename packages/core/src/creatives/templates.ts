import type { SlideSpec } from "./slide-spec.js";

export type { SlideSpec } from "./slide-spec.js";
export { validateSlideSpec } from "./slide-spec.js";

export type Zone = Readonly<{ x: number; y: number; w: number; h: number }>;
export type CanvasKind = "feed" | "story";
export type TemplateId = "hero" | "benefit" | "proof" | "review" | "price" | "cta";

/**
 * Layout family of an in-scene slide, chosen by its role in the plan (brief 13): the cover
 * shouts the hook, the middle slides read as captions over the scene, the price slide makes the
 * price the largest element, the last slide makes the action the largest. Scales multiply the
 * brand sizes; the measured-ink QA still judges the result.
 */
export type InSceneEmphasis = "cover" | "caption" | "price" | "action";
export const IN_SCENE_EMPHASIS: Readonly<
  Record<InSceneEmphasis, Readonly<{ headline: number; price: number; cta: number }>>
> = Object.freeze({
  cover: Object.freeze({ headline: 1, price: 1, cta: 1 }),
  caption: Object.freeze({ headline: 0.85, price: 0.9, cta: 1 }),
  price: Object.freeze({ headline: 0.85, price: 1.4, cta: 1 }),
  action: Object.freeze({ headline: 0.92, price: 1, cta: 1.25 }),
});
export const emphasisFor = (template: TemplateId): InSceneEmphasis =>
  template === "hero"
    ? "cover"
    : template === "price"
      ? "price"
      : template === "cta"
        ? "action"
        : "caption";
export type CreativeTemplate = Readonly<{
  id: TemplateId;
  version: number;
  canvas: Readonly<{ w: number; h: number }>;
  productZone: Zone;
  headlineZone: Zone;
  bodyZone?: Zone;
  badgeZone?: Zone;
  markZone: Zone;
  slideNumberZone: Zone;
  surfaceY: number;
  scrim: "none" | "top" | "bottom" | "both";
  textAlign: "left" | "center";
  maxHeadlineLines: number;
  productAnchor: "left" | "center" | "right";
}>;

export const CANVASES: Readonly<Record<CanvasKind, Readonly<{ w: number; h: number }>>> =
  Object.freeze({
    feed: Object.freeze({ w: 1080, h: 1350 }),
    story: Object.freeze({ w: 1080, h: 1920 }),
  });

type TemplateLayout = Omit<CreativeTemplate, "canvas">;
const feed: Readonly<Record<TemplateId, TemplateLayout>> = {
  hero: {
    id: "hero",
    version: 1,
    productZone: { x: 0.08, y: 0.3, w: 0.84, h: 0.46 },
    headlineZone: { x: 0.08, y: 0.1, w: 0.84, h: 0.16 },
    bodyZone: { x: 0.08, y: 0.8, w: 0.84, h: 0.08 },
    badgeZone: { x: 0.08, y: 0.895, w: 0.5, h: 0.045 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.76,
    scrim: "both",
    textAlign: "center",
    maxHeadlineLines: 2,
    productAnchor: "center",
  },
  benefit: {
    id: "benefit",
    version: 1,
    productZone: { x: 0.5, y: 0.28, w: 0.42, h: 0.5 },
    headlineZone: { x: 0.08, y: 0.1, w: 0.84, h: 0.16 },
    bodyZone: { x: 0.08, y: 0.32, w: 0.4, h: 0.4 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.78,
    scrim: "top",
    textAlign: "left",
    maxHeadlineLines: 2,
    productAnchor: "right",
  },
  proof: {
    id: "proof",
    version: 1,
    productZone: { x: 0.08, y: 0.55, w: 0.84, h: 0.3 },
    headlineZone: { x: 0.08, y: 0.1, w: 0.84, h: 0.3 },
    bodyZone: { x: 0.08, y: 0.42, w: 0.84, h: 0.08 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.85,
    scrim: "top",
    textAlign: "center",
    maxHeadlineLines: 3,
    productAnchor: "center",
  },
  review: {
    id: "review",
    version: 1,
    productZone: { x: 0.55, y: 0.5, w: 0.37, h: 0.36 },
    headlineZone: { x: 0.08, y: 0.1, w: 0.84, h: 0.12 },
    bodyZone: { x: 0.08, y: 0.26, w: 0.6, h: 0.4 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.86,
    scrim: "top",
    textAlign: "left",
    maxHeadlineLines: 2,
    productAnchor: "right",
  },
  price: {
    id: "price",
    version: 1,
    productZone: { x: 0.08, y: 0.36, w: 0.84, h: 0.4 },
    headlineZone: { x: 0.08, y: 0.08, w: 0.84, h: 0.22 },
    bodyZone: { x: 0.08, y: 0.8, w: 0.84, h: 0.06 },
    badgeZone: { x: 0.08, y: 0.88, w: 0.6, h: 0.05 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.76,
    scrim: "both",
    textAlign: "center",
    maxHeadlineLines: 2,
    productAnchor: "center",
  },
  cta: {
    id: "cta",
    version: 1,
    productZone: { x: 0.08, y: 0.3, w: 0.84, h: 0.4 },
    headlineZone: { x: 0.08, y: 0.1, w: 0.84, h: 0.16 },
    bodyZone: { x: 0.08, y: 0.74, w: 0.84, h: 0.08 },
    badgeZone: { x: 0.08, y: 0.86, w: 0.7, h: 0.06 },
    markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
    slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
    surfaceY: 0.7,
    scrim: "both",
    textAlign: "center",
    maxHeadlineLines: 2,
    productAnchor: "center",
  },
};

const storyZone = (zone: Zone, product = false): Zone => ({
  ...zone,
  y: zone.y * (1350 / 1920) + 0.06,
  h: zone.h * (1350 / 1920) + (product ? 0.04 : 0),
});
const story: Readonly<Record<TemplateId, TemplateLayout>> = Object.fromEntries(
  Object.entries(feed).map(([id, layout]) => [
    id,
    {
      ...layout,
      productZone: storyZone(layout.productZone, true),
      headlineZone: storyZone(layout.headlineZone),
      ...(layout.bodyZone ? { bodyZone: storyZone(layout.bodyZone) } : {}),
      ...(layout.badgeZone ? { badgeZone: storyZone(layout.badgeZone) } : {}),
      markZone: { x: 0.06, y: 0.05, w: 0.4, h: 0.06 },
      slideNumberZone: { x: 0.84, y: 0.05, w: 0.1, h: 0.04 },
      surfaceY: layout.surfaceY * (1350 / 1920) + 0.06,
    },
  ]),
) as Record<TemplateId, TemplateLayout>;

export const templateFor = (id: TemplateId, canvas: CanvasKind): CreativeTemplate =>
  Object.freeze({ ...(canvas === "feed" ? feed[id] : story[id]), canvas: CANVASES[canvas] });
