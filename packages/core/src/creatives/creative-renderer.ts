import type { BrandKit } from "../brand/brand-kit.js";
import type { CreativeBoxKey } from "./creative-document.js";
import type { SubjectBox } from "./in-scene-fidelity.js";
import type { PlatformPresetId } from "./platform-presets.js";
import type { PriceDisplay } from "./price-display.js";
import type { SlideSpec } from "./slide-spec.js";
import type { SubjectLayout } from "./subject-layout.js";
import type { CanvasKind, CreativeTemplate } from "./templates.js";

export type PixelBox = Readonly<{ x: number; y: number; w: number; h: number }>;
export type RenderSlideInput = Readonly<{
  canvas: CanvasKind;
  template: CreativeTemplate;
  spec: SlideSpec;
  brand: BrandKit;
  /** `inScene`: the product is already painted into `background` (png only); no product layer is drawn. */
  product: { png: Uint8Array; mode: "cutout" | "framed" } | { inScene: true };
  background: { png: Uint8Array } | { procedural: true };
  logo?: { png: Uint8Array };
  /** In-scene mode only: platform preset; defaults from the canvas. */
  preset?: PlatformPresetId;
  /** In-scene mode only: price pill drawn from verified facts; overrides `spec.badge` text. */
  price?: PriceDisplay;
  /** In-scene mode only: story call-to-action button label. */
  cta?: string;
  /**
   * Rows (fractions of the slide height) kept free for burned-in Reel captions: the in-scene
   * overlay stacks price, CTA and body above `top`; the disclosure tag may sit below `bottom`.
   */
  captionBand?: Readonly<{ top: number; bottom: number }>;
  /**
   * In-scene mode only: faces, people and the product in `background` (0..1000 boxes from the
   * fidelity VLM). The overlay keeps text off them; without them the default layout is drawn.
   */
  subjects?: readonly SubjectBox[];
}>;
export type RenderedSlide = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  layout: {
    headlineFontSize: number;
    bodyDropped: boolean;
    /** In-scene mode: where each overlay element was drawn. */
    boxes?: Readonly<Partial<Record<CreativeBoxKey, PixelBox>>>;
    /** In-scene mode: the measured ink of each text element (real glyph pixels, brief 13). */
    ink?: Readonly<Partial<Record<CreativeBoxKey, PixelBox>>>;
    /** In-scene mode with subjects: the chosen placements and any collision left. */
    subjectLayout?: SubjectLayout;
  };
  /** The product layer exactly as composited and where, so fidelity QA can align it. */
  product?: Readonly<{ layer: Uint8Array; region: PixelBox }>;
  /**
   * In-scene mode: every layer drawn over the scene on a transparent canvas (PNG), so a Reel can
   * move the scene (2.5D) under still text. `bytes` is the scene with this overlay composited.
   */
  overlay?: Uint8Array;
}>;
export interface CreativeRenderer {
  render(input: RenderSlideInput): Promise<RenderedSlide>;
}
export const RENDERER_VERSION = 1;
