import type { ChannelKind } from "../channels/channel.js";
import { type BrandKit, type BrandKitOverride, mergeBrandKit } from "./brand-kit.js";

export const CAPTION_PRESET_IDS = ["word_pop", "clean", "karaoke", "boxed", "documentary"] as const;
export type CaptionPresetId = (typeof CAPTION_PRESET_IDS)[number];
export const CAPTION_FONTS = ["Inter", "Montserrat", "Bebas Neue"] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];

export type CaptionTheme = Readonly<{
  id: CaptionPresetId;
  font: CaptionFont;
  weight: 700 | 800 | 900;
  /** Pixels at 1080 wide, 40-96. */
  size: number;
  baseColor: string;
  highlightColor: string;
  highlightMode: "color_pop" | "color" | "karaoke_fill" | "none";
  surface: "outline" | "box" | "shadow";
  surfaceColor: string;
  position: "bottom" | "lower_third" | "center";
  maxWords: 1 | 2 | 3 | 4;
  uppercase: boolean;
}>;

/** Fonts present in the image (deploy/fonts, docs/operations/fonts.md); others resolve to Inter (INV-B4). */
export const INSTALLED_FONTS: readonly CaptionFont[] = ["Inter", "Montserrat", "Bebas Neue"];

const preset = (id: CaptionPresetId, changes: Partial<CaptionTheme>): CaptionTheme => ({
  id,
  font: "Inter",
  weight: 700,
  size: 64,
  baseColor: "#FFFFFF",
  highlightColor: "#FFFF00",
  highlightMode: "color_pop",
  surface: "outline",
  surfaceColor: "#000000",
  position: "bottom",
  maxWords: 3,
  uppercase: false,
  ...changes,
});

export const CAPTION_PRESETS: Readonly<Record<CaptionPresetId, CaptionTheme>> = Object.freeze({
  word_pop: preset("word_pop", {}),
  clean: preset("clean", { highlightMode: "none", surface: "shadow" }),
  karaoke: preset("karaoke", { highlightMode: "karaoke_fill", size: 68 }),
  boxed: preset("boxed", { surface: "box", surfaceColor: "#161616" }),
  documentary: preset("documentary", {
    highlightMode: "none",
    surface: "shadow",
    size: 48,
    position: "lower_third",
    maxWords: 4,
  }),
});

/** Niche context `captionTheme`: a preset plus overrides; brand colours are opt-in. */
export type CaptionThemeConfig = Partial<Omit<CaptionTheme, "id">> &
  Readonly<{ preset?: CaptionPresetId; useBrandColors?: boolean }>;

export type ResolvedCaptionTheme = CaptionTheme &
  Readonly<{
    marginV: number;
    marginR: number;
    canvas: "portrait" | "landscape";
    /** Set when the requested theme failed the contrast check and word_pop was used instead. */
    fallback?: true;
  }>;

const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
const oneOf = <T extends string | number>(list: readonly T[], value: unknown): value is T =>
  list.includes(value as T);

/** Lenient read of niche context: invalid fields are dropped (the MCP boundary validates strictly). */
export const readCaptionThemeConfig = (
  context: Readonly<Record<string, unknown>> | null | undefined,
): CaptionThemeConfig | undefined => {
  const raw = context?.["captionTheme"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (oneOf(CAPTION_PRESET_IDS, r["preset"])) out["preset"] = r["preset"];
  if (oneOf(CAPTION_FONTS, r["font"])) out["font"] = r["font"];
  if (oneOf([700, 800, 900], r["weight"])) out["weight"] = r["weight"];
  if (typeof r["size"] === "number" && r["size"] >= 40 && r["size"] <= 96) out["size"] = r["size"];
  for (const key of ["baseColor", "highlightColor", "surfaceColor"])
    if (isHex(r[key])) out[key] = r[key];
  if (oneOf(["color_pop", "color", "karaoke_fill", "none"], r["highlightMode"]))
    out["highlightMode"] = r["highlightMode"];
  if (oneOf(["outline", "box", "shadow"], r["surface"])) out["surface"] = r["surface"];
  if (oneOf(["bottom", "lower_third", "center"], r["position"])) out["position"] = r["position"];
  if (oneOf([1, 2, 3, 4], r["maxWords"])) out["maxWords"] = r["maxWords"];
  if (typeof r["uppercase"] === "boolean") out["uppercase"] = r["uppercase"];
  if (typeof r["useBrandColors"] === "boolean") out["useBrandColors"] = r["useBrandColors"];
  return Object.keys(out).length > 0 ? (out as CaptionThemeConfig) : undefined;
};

const luminance = (hex: string): number => {
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const BASE_MARGIN: Readonly<Record<CaptionTheme["position"], number>> = {
  bottom: 576,
  lower_third: 420,
  center: 0,
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type ResolveCaptionThemeInput = Readonly<{
  niche?: Readonly<{ context?: Readonly<Record<string, unknown>> | null }>;
  brandKit?: BrandKit;
  visualLanguage?: Readonly<{ type: Readonly<{ captionPx: number; maxWordsChunk: number }> }>;
  canvas: "portrait" | "landscape";
  channelKind?: ChannelKind;
}>;

const finish = (theme: CaptionTheme, input: ResolveCaptionThemeInput): ResolvedCaptionTheme => {
  const portrait = input.canvas === "portrait";
  const base = portrait
    ? BASE_MARGIN[theme.position]
    : Math.round(BASE_MARGIN[theme.position] / 3.55);
  const floor = theme.position === "center" ? 0 : portrait ? 384 : 108;
  return {
    ...theme,
    font: INSTALLED_FONTS.includes(theme.font) ? theme.font : "Inter",
    marginV: Math.max(floor, base),
    marginR: portrait ? 160 : 80,
    canvas: input.canvas,
  };
};

/** Order: preset, brand kit (opt-in), niche overrides, visual language, safe zone, contrast. */
export const resolveCaptionTheme = (input: ResolveCaptionThemeInput): ResolvedCaptionTheme => {
  const config = readCaptionThemeConfig(input.niche?.context) ?? {};
  const { preset: presetId, useBrandColors, ...overrides } = config;
  let theme: CaptionTheme = { ...CAPTION_PRESETS[presetId ?? "word_pop"] };
  if (useBrandColors && input.brandKit)
    theme = {
      ...theme,
      highlightColor: input.brandKit.palette.accent,
      baseColor: input.brandKit.palette.text,
    };
  theme = { ...theme, ...overrides };
  const type = input.visualLanguage?.type;
  if (type)
    theme = {
      ...theme,
      size: type.captionPx,
      maxWords: clamp(Math.round(type.maxWordsChunk), 1, 4) as CaptionTheme["maxWords"],
    };
  theme = { ...theme, size: clamp(Math.round(theme.size), 40, 96) };

  const texts = [
    theme.baseColor,
    ...(theme.highlightMode === "none" ? [] : [theme.highlightColor]),
  ];
  if (texts.some((colour) => contrastRatio(colour, theme.surfaceColor) < 4.5))
    return { ...finish(CAPTION_PRESETS.word_pop, input), fallback: true };
  return finish(theme, input);
};

/**
 * The theme for a niche that configured `captionTheme`, else undefined so callers keep their
 * legacy caption style (INV-B5). Brand kit layers: niche, then channel (the handlers have no
 * workspace context).
 */
export const resolveNicheCaptionTheme = (
  input: Readonly<{
    niche?: Readonly<{ context?: Readonly<Record<string, unknown>> | null }> | null | undefined;
    channel?: Readonly<{ context?: Readonly<Record<string, unknown>> | null }> | null | undefined;
    canvas: "portrait" | "landscape";
    channelKind?: ChannelKind;
  }>,
): ResolvedCaptionTheme | undefined => {
  if (!readCaptionThemeConfig(input.niche?.context)) return undefined;
  const record = (value: unknown): BrandKitOverride | undefined =>
    typeof value === "object" && value !== null ? (value as BrandKitOverride) : undefined;
  let brandKit: BrandKit | undefined;
  try {
    brandKit = mergeBrandKit(
      record(input.niche?.context?.["brandKit"]),
      record(input.channel?.context?.["brandKit"]),
    );
  } catch {
    brandKit = undefined; // invalid brand colours never fail a render; the preset colours apply
  }
  return resolveCaptionTheme({
    niche: input.niche ?? {},
    ...(brandKit ? { brandKit } : {}),
    canvas: input.canvas,
    ...(input.channelKind ? { channelKind: input.channelKind } : {}),
  });
};
