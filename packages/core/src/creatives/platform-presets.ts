import type { ChannelKind } from "../channels/channel.js";
import type { CanvasKind } from "./templates.js";

/** Fractions of the canvas (0..1). */
export type PresetZone = Readonly<{ x: number; y: number; w: number; h: number }>;
export type CtaKind = "comment_keyword" | "link_in_bio" | "see_offer" | "save_post";
export type PlatformPresetId = "instagram_feed" | "instagram_story" | "tiktok_photo" | "threads";

export type CtaPolicy = Readonly<{
  allowed: readonly CtaKind[];
  default: CtaKind;
  /** A CTA that promises work a person must do (no automation exists); named so it stays visible. */
  requiresWorkflow?: Readonly<Partial<Record<CtaKind, "manual_dm_reply">>>;
}>;
export type DisclosurePolicy = Readonly<{
  text: "#publi";
  /** Minimum glyph size on a 1080 px wide canvas; scale by width / 1080. */
  minPx: number;
  /** WCAG contrast of the text against its pill. */
  minContrast: number;
}>;
export type PlatformPreset = Readonly<{
  id: PlatformPresetId;
  canvas: Readonly<{ w: number; h: number }>;
  canvasKind: CanvasKind;
  safe: PresetZone;
  uiBlocked: readonly PresetZone[];
  /** `carousel_only` draws i/n only when the post has more than one image. */
  counter: "never" | "carousel_only";
  cta: CtaPolicy;
  disclosure: DisclosurePolicy;
}>;

export const CTA_TEXT: Readonly<Record<CtaKind, string>> = Object.freeze({
  comment_keyword: "Comente QUERO",
  link_in_bio: "Link na bio",
  see_offer: "Veja a oferta",
  save_post: "Salve este post",
});

const disclosure: DisclosurePolicy = Object.freeze({ text: "#publi", minPx: 28, minContrast: 4.5 });
const instagramCta = Object.freeze<CtaPolicy>({
  allowed: ["comment_keyword", "link_in_bio", "save_post"],
  default: "link_in_bio",
  requiresWorkflow: Object.freeze({ comment_keyword: "manual_dm_reply" as const }),
});
const tiktokCta = Object.freeze<CtaPolicy>({
  // TikTok captions cannot carry links.
  allowed: ["link_in_bio", "save_post"],
  default: "link_in_bio",
});
const feedCanvas = Object.freeze({ w: 1080, h: 1350 });
const storyCanvas = Object.freeze({ w: 1080, h: 1920 });
const feedSafe = Object.freeze({ x: 0.06, y: 0.05, w: 0.88, h: 0.9 });
const storyUi = Object.freeze([
  Object.freeze({ x: 0, y: 0, w: 1, h: 0.14 }),
  Object.freeze({ x: 0, y: 0.8, w: 1, h: 0.2 }),
]);
const storySafe = Object.freeze({ x: 0.06, y: 0.14, w: 0.88, h: 0.66 });

export const PLATFORM_PRESETS: Readonly<Record<PlatformPresetId, PlatformPreset>> = Object.freeze({
  instagram_feed: {
    id: "instagram_feed",
    canvas: feedCanvas,
    canvasKind: "feed",
    safe: feedSafe,
    uiBlocked: [],
    counter: "carousel_only",
    cta: instagramCta,
    disclosure,
  },
  instagram_story: {
    id: "instagram_story",
    canvas: storyCanvas,
    canvasKind: "story",
    safe: storySafe,
    uiBlocked: storyUi,
    counter: "carousel_only",
    cta: instagramCta,
    disclosure,
  },
  tiktok_photo: {
    id: "tiktok_photo",
    canvas: storyCanvas,
    canvasKind: "story",
    safe: storySafe,
    uiBlocked: storyUi,
    counter: "carousel_only",
    cta: tiktokCta,
    disclosure,
  },
  threads: {
    id: "threads",
    canvas: feedCanvas,
    canvasKind: "feed",
    safe: feedSafe,
    uiBlocked: [],
    counter: "never",
    cta: instagramCta,
    disclosure,
  },
});

const PRESET_BY_KIND: Readonly<Partial<Record<ChannelKind, PlatformPresetId>>> = Object.freeze({
  instagram_carousel: "instagram_feed",
  instagram_stories: "instagram_story",
  tiktok_photo_post: "tiktok_photo",
  threads: "threads",
});

/** Image channels only; reels, YouTube and TikTok video have no still-image preset. */
export const presetForChannelKind = (kind: ChannelKind): PlatformPreset | null => {
  const id = PRESET_BY_KIND[kind];
  return id ? PLATFORM_PRESETS[id] : null;
};
export const presetForCanvas = (canvas: CanvasKind): PlatformPreset =>
  PLATFORM_PRESETS[canvas === "story" ? "instagram_story" : "instagram_feed"];

export const showCounter = (preset: PlatformPreset, total: number): boolean =>
  preset.counter === "carousel_only" && total > 1;

/** Pixel rows free of platform UI: [top, bottom) for a canvas of height `h`. */
export const uiFreeRows = (preset: PlatformPreset, h: number): { top: number; bottom: number } => {
  let top = 0;
  let bottom = h;
  for (const zone of preset.uiBlocked) {
    if (zone.y === 0) top = Math.max(top, Math.ceil((zone.y + zone.h) * h));
    else if (zone.y + zone.h >= 1) bottom = Math.min(bottom, Math.floor(zone.y * h));
  }
  return { top, bottom };
};

const channel = (hex: string, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number =>
  0.2126 * linear(channel(hex, 1)) +
  0.7152 * linear(channel(hex, 3)) +
  0.0722 * linear(channel(hex, 5));

/** WCAG 2.x contrast ratio of two #rrggbb colours, 1..21. */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Label colour on a filled pill (price, CTA): white while it reaches WCAG AA 4.5 on the fill,
 * else the brand's dark ink, else black. White on the default cyan accent is about 1.7:1.
 */
export const pillLabelColour = (fill: string, dark: string): string =>
  ["#ffffff", dark, "#000000"].find((colour) => contrastRatio(colour, fill) >= 4.5) ?? "#000000";
