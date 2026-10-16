/**
 * 9:16 frame geometry shared by the scene composer and the caption renderer. No platform
 * publishes official organic safe zones; SAFE_BOX is the union of third-party TikTok, Reels and
 * Shorts overlays (spec D.1), so essential content inside it survives every platform UI.
 */
export const FRAME = Object.freeze({ width: 1080, height: 1920 });
export const SAFE_BOX = Object.freeze({ left: 120, right: 870, top: 290, bottom: 1250 });
/** Captions live here; scene text never enters this band. */
export const CAPTION_BAND = Object.freeze({ top: 1000, bottom: 1250 });
/** Character feet sit on this line, just above the bottom of SAFE_BOX. */
export const BASELINE_Y = 1180;
/** ASS MarginV (from the bottom edge at PlayResY 1920) that puts captions inside CAPTION_BAND. */
export const MEDIA_CAPTION_MARGIN_V = FRAME.height - CAPTION_BAND.bottom;

export type StagePosition = "left" | "center" | "right";
export type Canvas = "portrait" | "landscape";
type Box = Readonly<{ left: number; right: number; top: number; bottom: number }>;

/**
 * Everything about a canvas that is geometry rather than style: frame size, safe area, caption
 * band, ground line, stage columns, overlay and prop heights. Style-semantic values (palette
 * areas, value tiers, hero area %) stay in the visual-language profile. Portrait is exactly the
 * constants above, so portrait frames do not change; landscape is its own set (1920x1080 with a
 * 5% action-safe margin and a caption band along the bottom edge), never a 1080<->1920 swap.
 */
export type CanvasGeometry = Readonly<{
  canvas: Canvas;
  frame: Readonly<{ width: number; height: number }>;
  safeBox: Box;
  captionBand: Readonly<{ top: number; bottom: number }>;
  baselineY: number;
  stageX: Readonly<Record<StagePosition, number>>;
  /** Overlay text baselines, and the x they are centred on in stills. */
  overlayY: Readonly<{ top: number; middle: number }>;
  overlayStillCx: number;
  /** Prop anchor heights: floating above the stage ("top") or beside the torso. */
  propY: Readonly<{ top: number; stage: number }>;
  /** Where entering and exiting actors start and end, just outside the frame. */
  offstageX: Readonly<{ left: number; right: number }>;
  /** Overlay text fits this width; captions fit and cap their plate at these. */
  overlayFitWidth: number;
  captionFitWidth: number;
  captionMaxWidth: number;
  /** Camera zoom focus. */
  cameraFocus: Readonly<{ x: number; y: number }>;
  /** Where the 750x600 diagram area lands on the frame, and the scale it is drawn at. */
  diagramRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  diagramScale: number;
  /** Where painted background art is drawn: the frame plus bleed for the far layer's parallax. */
  artBox: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

export const PORTRAIT_GEOMETRY: CanvasGeometry = Object.freeze({
  canvas: "portrait",
  frame: FRAME,
  safeBox: SAFE_BOX,
  captionBand: CAPTION_BAND,
  baselineY: BASELINE_Y,
  stageX: Object.freeze({ left: 300, center: 540, right: 780 }),
  overlayY: Object.freeze({ top: 400, middle: 940 }),
  overlayStillCx: (SAFE_BOX.left + SAFE_BOX.right) / 2,
  propY: Object.freeze({ top: 520, stage: 780 }),
  offstageX: Object.freeze({ left: -220, right: 1300 }),
  overlayFitWidth: SAFE_BOX.right - SAFE_BOX.left,
  captionFitWidth: 700,
  captionMaxWidth: 820,
  cameraFocus: Object.freeze({ x: FRAME.width / 2, y: 900 }),
  diagramRect: Object.freeze({ x: 120, y: 330, width: 750, height: 600 }),
  diagramScale: 1,
  // Equals BACKGROUND_ART_BOX (background-art.ts); a test holds them together.
  artBox: Object.freeze({ x: -60, y: -106, width: 1200, height: 2132 }),
});

/**
 * 1920x1080. Safe area = 5% margins. Captions get a 102 px band along the bottom of the safe
 * area (one line of up to 64 px text on its plate); feet stand 34 px above it. Stage columns sit
 * 420 / 960 / 1500 so a two-shot keeps a conversation gap and a centred diagram (566..1354)
 * clears both side columns.
 */
export const LANDSCAPE_GEOMETRY: CanvasGeometry = Object.freeze({
  canvas: "landscape",
  frame: Object.freeze({ width: 1920, height: 1080 }),
  safeBox: Object.freeze({ left: 96, right: 1824, top: 54, bottom: 1026 }),
  captionBand: Object.freeze({ top: 924, bottom: 1026 }),
  baselineY: 890,
  stageX: Object.freeze({ left: 420, center: 960, right: 1500 }),
  overlayY: Object.freeze({ top: 150, middle: 540 }),
  overlayStillCx: 960,
  propY: Object.freeze({ top: 330, stage: 600 }),
  offstageX: Object.freeze({ left: -220, right: 2140 }),
  overlayFitWidth: 1600,
  captionFitWidth: 1400,
  captionMaxWidth: 1500,
  cameraFocus: Object.freeze({ x: 960, y: 520 }),
  diagramRect: Object.freeze({ x: 566, y: 100, width: 788, height: 630 }),
  diagramScale: 1.05,
  artBox: Object.freeze({ x: -106, y: -60, width: 2132, height: 1200 }),
});

export const geometryFor = (canvas: Canvas | undefined): CanvasGeometry =>
  canvas === "landscape" ? LANDSCAPE_GEOMETRY : PORTRAIT_GEOMETRY;

export const positionX = (
  position: StagePosition,
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): number => geometry.stageX[position];

/** Average advance of bold Inter glyphs, in em; conservative so estimates err on the small side. */
const BOLD_EM_PER_CHAR = 0.66;
/** Largest font size (up to base) at which a single line of text fits maxWidth. */
export const fitFontSize = (text: string, base: number, maxWidth: number): number =>
  Math.min(base, Math.floor(maxWidth / (Math.max(1, text.length) * BOLD_EM_PER_CHAR)));

export const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rounds SVG coordinates so output is stable and compact. */
export const n = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};
