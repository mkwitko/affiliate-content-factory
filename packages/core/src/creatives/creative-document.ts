import type { PixelBox } from "./creative-renderer.js";
import type { CtaKind, PlatformPresetId } from "./platform-presets.js";
import type { PriceDisplay } from "./price-display.js";
import type { CreativeQualityReport } from "./slide-quality.js";
import type { SlideSpec } from "./slide-spec.js";
import type { SubjectLayout } from "./subject-layout.js";

export type LayoutFamilyId = "character_product" | "product_cutout";
export type CreativeBoxKey =
  | "logo"
  | "headline"
  | "body"
  | "price"
  | "cta"
  | "disclosure"
  | "subject";

/**
 * Everything needed to explain and re-render a slide without regenerating art. Stored in the
 * rendered asset's metadata under `creativeDocument` (no table yet).
 */
export type CreativeDocument = Readonly<{
  version: 1;
  rendererVersion: number;
  brandKitHash: string;
  preset: PlatformPresetId;
  layoutFamily: LayoutFamilyId;
  layers: Readonly<{
    scene?: Readonly<{ assetId: string; checksum: string }>;
    product: Readonly<{ mode: "in_scene" | "cutout" | "framed"; assetId?: string }>;
    logo?: Readonly<{ assetId: string }>;
  }>;
  copy: SlideSpec;
  price?: PriceDisplay;
  cta?: Readonly<{
    kind: CtaKind;
    text: string;
    /** A person must act for this CTA to be honest (e.g. answer comments). */
    requiresWorkflow?: "manual_dm_reply";
  }>;
  boxes: Readonly<Partial<Record<CreativeBoxKey, PixelBox>>>;
  /** In-scene slides drawn around subject boxes: placements chosen and collisions left. */
  subjectLayout?: SubjectLayout;
  /** Legibility QA of the drawn text (geometry and measured contrast). */
  quality?: CreativeQualityReport;
}>;

/** The pinned scene of a stored document; tolerant of metadata written by older renders. */
export const pinnedSceneId = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const doc = metadata?.creativeDocument as
    | { layers?: { scene?: { assetId?: unknown } } }
    | undefined;
  const id = doc?.layers?.scene?.assetId;
  return typeof id === "string" ? id : undefined;
};
