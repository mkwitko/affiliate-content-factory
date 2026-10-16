import {
  CAPTION_BAND,
  type Canvas,
  type CanvasGeometry,
  FRAME,
  LANDSCAPE_GEOMETRY,
  PORTRAIT_GEOMETRY,
  SAFE_BOX,
  type StagePosition,
} from "./layout.js";
import { SHOT_SCALE } from "./shots.js";

/**
 * Layout registry (Stickman v2 spec 14.3, slice 23): named compositions a director picks by id.
 * Rects are normalised to the 9:16 frame. SOLO_* and ACTOR_DIAGRAM_SPLIT are today's implicit
 * layout (stage x 300/540/780, overlays at y 400/940, diagram in the upper stage), so existing
 * specs map without change. Landscape has its own rects (LANDSCAPE_LAYOUTS) under the same ids.
 */
export const LAYOUT_IDS = [
  "SOLO_CENTER",
  "SOLO_LEFT",
  "SOLO_RIGHT",
  "TWO_SHOT",
  "TWO_STACK",
  "ACTOR_LEFT_TEXT_RIGHT",
  "ACTOR_RIGHT_TEXT_LEFT",
  "ACTOR_LEFT_PROP_RIGHT",
  "ACTOR_RIGHT_PROP_LEFT",
  "ACTOR_DIAGRAM_SPLIT",
  "CLOSE_REACTION",
  "OBJECT_INSERT",
  "WIDE_ENVIRONMENT",
  "COMPARISON_SPLIT",
  "TIMELINE",
] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type Layout = Readonly<{
  id: LayoutId;
  /** Stage positions actors may take, in order. */
  actorSlots: readonly StagePosition[];
  minActors: number;
  actorRects: readonly Rect[];
  textRect?: Rect;
  propRect?: Rect;
  diagramRect?: Rect;
  needsProp?: boolean;
  needsDiagram?: boolean;
  /** Where overlays may sit. */
  overlayPositions: readonly ("top" | "middle")[];
}>;

/** Per-canvas sizes of the rect helpers; the portrait values are the original literals. */
type Dims = Readonly<{
  textTop: Readonly<{ y: number; h: number }>;
  side: Readonly<{ y: number; h: number; leftW: number; rightX: number }>;
  upperStage: Readonly<{ x: number; y: number; w: number; h: number }>;
  propTop: number;
  /** Close and wide layouts size their actor rects by shot scale (landscape only). */
  shotRects: boolean;
}>;
const DIMS: Readonly<Record<Canvas, Dims>> = {
  portrait: {
    textTop: { y: 330, h: 140 },
    side: { y: 330, h: 260, leftW: 400, rightX: 560 },
    upperStage: {
      x: SAFE_BOX.left,
      y: SAFE_BOX.top,
      w: SAFE_BOX.right - SAFE_BOX.left,
      h: 360,
    },
    propTop: 690,
    shotRects: false,
  },
  landscape: {
    textTop: { y: 70, h: 120 },
    side: { y: 200, h: 400, leftW: 1064, rightX: 760 },
    upperStage: {
      x: LANDSCAPE_GEOMETRY.diagramRect.x,
      y: LANDSCAPE_GEOMETRY.diagramRect.y,
      w: LANDSCAPE_GEOMETRY.diagramRect.width,
      h: LANDSCAPE_GEOMETRY.diagramRect.height,
    },
    propTop: LANDSCAPE_GEOMETRY.propY.stage - 90,
    shotRects: true,
  },
};

const buildLayouts = (geo: CanvasGeometry): Readonly<Record<LayoutId, Layout>> => {
  const d = DIMS[geo.canvas];
  const W = geo.frame.width;
  const H = geo.frame.height;
  const safe = geo.safeBox;
  const BASELINE_Y = geo.baselineY;
  /** An actor's box around its stage x, from the head top to the feet, at medium scale. */
  const actorRect = (x: number, scale = 1): Rect => ({
    x: (x - 130 * scale) / W,
    y: (BASELINE_Y - 530 * scale) / H,
    w: (260 * scale) / W,
    h: (560 * scale - 30 * (scale - 1)) / H,
  });
  const LEFT = geo.stageX.left;
  const CENTER = geo.stageX.center;
  const RIGHT = geo.stageX.right;
  const closeScale = d.shotRects ? SHOT_SCALE.close : 1;
  const wideScale = d.shotRects ? SHOT_SCALE.wide : 1;
  /** Text above the heads: the overlay band (top) inside the safe box. */
  const TOP_TEXT: Rect = {
    x: safe.left / W,
    y: d.textTop.y / H,
    w: (safe.right - safe.left) / W,
    h: d.textTop.h / H,
  };
  const SIDE_TEXT = (side: "left" | "right"): Rect => ({
    x: side === "left" ? safe.left / W : d.side.rightX / W,
    y: d.side.y / H,
    w: (side === "left" ? d.side.leftW : safe.right - d.side.rightX) / W,
    h: d.side.h / H,
  });
  const UPPER_STAGE: Rect = {
    x: d.upperStage.x / W,
    y: d.upperStage.y / H,
    w: d.upperStage.w / W,
    h: d.upperStage.h / H,
  };
  const PROP = (x: number): Rect => ({ x: (x - 90) / W, y: d.propTop / H, w: 180 / W, h: 180 / H });

  return {
    SOLO_CENTER: {
      id: "SOLO_CENTER",
      actorSlots: ["center"],
      minActors: 1,
      actorRects: [actorRect(CENTER)],
      textRect: TOP_TEXT,
      overlayPositions: ["top", "middle"],
    },
    SOLO_LEFT: {
      id: "SOLO_LEFT",
      actorSlots: ["left"],
      minActors: 1,
      actorRects: [actorRect(LEFT)],
      textRect: TOP_TEXT,
      overlayPositions: ["top", "middle"],
    },
    SOLO_RIGHT: {
      id: "SOLO_RIGHT",
      actorSlots: ["right"],
      minActors: 1,
      actorRects: [actorRect(RIGHT)],
      textRect: TOP_TEXT,
      overlayPositions: ["top", "middle"],
    },
    TWO_SHOT: {
      id: "TWO_SHOT",
      actorSlots: ["left", "right"],
      minActors: 2,
      actorRects: [actorRect(LEFT), actorRect(RIGHT)],
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    TWO_STACK: {
      id: "TWO_STACK",
      actorSlots: ["left", "center"],
      minActors: 2,
      actorRects: [actorRect(LEFT), actorRect(CENTER)],
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    ACTOR_LEFT_TEXT_RIGHT: {
      id: "ACTOR_LEFT_TEXT_RIGHT",
      actorSlots: ["left"],
      minActors: 1,
      actorRects: [actorRect(LEFT)],
      textRect: SIDE_TEXT("right"),
      overlayPositions: ["top", "middle"],
    },
    ACTOR_RIGHT_TEXT_LEFT: {
      id: "ACTOR_RIGHT_TEXT_LEFT",
      actorSlots: ["right"],
      minActors: 1,
      actorRects: [actorRect(RIGHT)],
      textRect: SIDE_TEXT("left"),
      overlayPositions: ["top", "middle"],
    },
    ACTOR_LEFT_PROP_RIGHT: {
      id: "ACTOR_LEFT_PROP_RIGHT",
      actorSlots: ["left"],
      minActors: 1,
      actorRects: [actorRect(LEFT)],
      propRect: PROP(RIGHT),
      needsProp: true,
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    ACTOR_RIGHT_PROP_LEFT: {
      id: "ACTOR_RIGHT_PROP_LEFT",
      actorSlots: ["right"],
      minActors: 1,
      actorRects: [actorRect(RIGHT)],
      propRect: PROP(LEFT),
      needsProp: true,
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    ACTOR_DIAGRAM_SPLIT: {
      id: "ACTOR_DIAGRAM_SPLIT",
      actorSlots: ["left", "right", "center"],
      minActors: 1,
      actorRects: [actorRect(LEFT)],
      diagramRect: UPPER_STAGE,
      needsDiagram: true,
      overlayPositions: [],
    },
    CLOSE_REACTION: {
      id: "CLOSE_REACTION",
      actorSlots: ["center"],
      minActors: 1,
      actorRects: [actorRect(CENTER, closeScale)],
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    OBJECT_INSERT: {
      id: "OBJECT_INSERT",
      actorSlots: [],
      minActors: 0,
      actorRects: [],
      propRect: PROP(CENTER),
      needsProp: true,
      textRect: TOP_TEXT,
      overlayPositions: ["top", "middle"],
    },
    WIDE_ENVIRONMENT: {
      id: "WIDE_ENVIRONMENT",
      actorSlots: ["left", "center", "right"],
      minActors: 0,
      actorRects: [
        actorRect(LEFT, wideScale),
        actorRect(CENTER, wideScale),
        actorRect(RIGHT, wideScale),
      ],
      textRect: TOP_TEXT,
      overlayPositions: ["top"],
    },
    COMPARISON_SPLIT: {
      id: "COMPARISON_SPLIT",
      actorSlots: ["left", "right"],
      minActors: 0,
      actorRects: [],
      diagramRect: UPPER_STAGE,
      needsDiagram: true,
      overlayPositions: [],
    },
    TIMELINE: {
      id: "TIMELINE",
      actorSlots: ["left", "right", "center"],
      minActors: 0,
      actorRects: [],
      diagramRect: UPPER_STAGE,
      needsDiagram: true,
      overlayPositions: [],
    },
  };
};

export const LAYOUTS = buildLayouts(PORTRAIT_GEOMETRY);
/** Landscape slot geometry for every layout id (same ids, 1920x1080 rects). */
export const LANDSCAPE_LAYOUTS = buildLayouts(LANDSCAPE_GEOMETRY);
export const layoutsFor = (canvas: Canvas | undefined): Readonly<Record<LayoutId, Layout>> =>
  canvas === "landscape" ? LANDSCAPE_LAYOUTS : LAYOUTS;

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The head band of an actor rect: its top fifth. Text must never cover it. */
export const headBand = (rect: Rect): Rect => ({ ...rect, h: rect.h / 5 });

/** Every rect sits inside the frame and captions keep their band clear. */
export const captionRect = (geo: CanvasGeometry): Rect => ({
  x: 0,
  y: geo.captionBand.top / geo.frame.height,
  w: 1,
  h: (geo.captionBand.bottom - geo.captionBand.top) / geo.frame.height,
});
export const CAPTION_RECT: Rect = captionRect(PORTRAIT_GEOMETRY);

export type LayoutMismatch =
  | "layout_actor_count"
  | "layout_actor_position"
  | "layout_needs_prop"
  | "layout_needs_diagram"
  | "layout_overlay_position";

/** How a scene breaks its declared layout, or null when it fits. */
export const layoutMismatch = (
  layout: Layout,
  scene: Readonly<{
    actors: readonly Readonly<{ position: StagePosition }>[];
    props: readonly unknown[];
    diagram?: unknown;
    overlays: readonly Readonly<{ position: "top" | "middle" }>[];
  }>,
): LayoutMismatch | null => {
  if (
    scene.actors.length < layout.minActors ||
    scene.actors.length > Math.max(layout.actorSlots.length, 0)
  )
    return "layout_actor_count";
  if (scene.actors.some((actor) => !layout.actorSlots.includes(actor.position)))
    return "layout_actor_position";
  if (layout.needsProp && scene.props.length === 0) return "layout_needs_prop";
  if (layout.needsDiagram && scene.diagram === undefined) return "layout_needs_diagram";
  if (scene.overlays.some((overlay) => !layout.overlayPositions.includes(overlay.position)))
    return "layout_overlay_position";
  return null;
};
