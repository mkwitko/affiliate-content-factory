import { createHash } from "node:crypto";

/** Sizes in px assume a 1080 px wide canvas and scale with width; ratios are unitless. */
export type BrandTokens = Readonly<{
  headlineMinPx: number;
  headlineMaxPx: number;
  /** Feed body size; story adds 4. */
  bodyPx: number;
  weightHeadline: number;
  weightBody: number;
  /** Card corner radius. */
  radius: number;
  /** Price pill horizontal padding as a fraction of the pill height. */
  pillPadding: number;
  /** Headline halo stroke as a fraction of the font size. */
  haloEm: number;
  shadowOpacity: number;
  disclosurePx: number;
}>;
/** The numbers the in-scene overlay hardcoded before tokens existed (plus the 28 px disclosure floor). */
export const DEFAULT_BRAND_TOKENS: BrandTokens = Object.freeze({
  headlineMinPx: 52,
  headlineMaxPx: 86,
  bodyPx: 42,
  weightHeadline: 800,
  weightBody: 700,
  radius: 32,
  pillPadding: 0.45,
  haloEm: 0.16,
  shadowOpacity: 0.45,
  disclosurePx: 28,
});

export type BrandKit = Readonly<{
  logoLightAssetId?: string;
  logoDarkAssetId?: string;
  palette: Readonly<{
    primary: string;
    secondary?: string;
    accent: string;
    surface: string;
    text: string;
    muted?: string;
    /** Text and mark colour on light scenes; falls back to `primary`. */
    dark?: string;
    /** Card and pill fill; falls back to `surface`. */
    light?: string;
  }>;
  tokens?: Partial<BrandTokens>;
  typography: Readonly<{ family: "Inter"; headingWeight: 700 | 800; bodyWeight: 400 | 500 }>;
  mark: Readonly<{
    position: "top-left" | "top-right" | "bottom-left";
    minWidth: number;
    safeMargin: number;
  }>;
  brandName: string;
  nicheLabel?: string;
}>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type BrandKitOverride = DeepPartial<BrandKit>;

export const DEFAULT_BRAND_KIT: BrandKit = Object.freeze({
  palette: Object.freeze({
    primary: "#0B1F3A",
    accent: "#22D3EE",
    surface: "#F5F7FA",
    text: "#FFFFFF",
    muted: "#9FB3C8",
  }),
  tokens: DEFAULT_BRAND_TOKENS,
  typography: Object.freeze({ family: "Inter", headingWeight: 800, bodyWeight: 500 }),
  mark: Object.freeze({ position: "top-left", minWidth: 160, safeMargin: 0.06 }),
  brandName: "Example Shop",
});

const hexColour = /^#[0-9a-fA-F]{6}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeLayer = (
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    merged[key] = isRecord(value) ? mergeLayer(isRecord(base[key]) ? base[key] : {}, value) : value;
  }
  const tokens = brandTokens(merged);
  for (const [name, value] of Object.entries(tokens)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`brand_kit_invalid_token:${name}`);
  }
  if (tokens.headlineMinPx > tokens.headlineMaxPx)
    throw new Error("brand_kit_invalid_token:headlineMinPx");
  if (tokens.shadowOpacity > 1) throw new Error("brand_kit_invalid_token:shadowOpacity");
  return merged;
};

export const brandTokens = (kit: Pick<BrandKit, "tokens">): BrandTokens => ({
  ...DEFAULT_BRAND_TOKENS,
  ...kit.tokens,
});

export const mergeBrandKit = (
  ...layers: readonly (BrandKitOverride | null | undefined)[]
): BrandKit => {
  const merged = layers.reduce<Record<string, unknown>>(
    (current, layer) => (layer ? mergeLayer(current, layer as Record<string, unknown>) : current),
    structuredClone(DEFAULT_BRAND_KIT) as unknown as Record<string, unknown>,
  ) as unknown as BrandKit;
  for (const [name, colour] of Object.entries(merged.palette)) {
    if (colour !== undefined && !hexColour.test(colour))
      throw new Error(`brand_kit_invalid_colour:${name}`);
  }
  return merged;
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
};

export const brandKitHash = (kit: BrandKit): string =>
  createHash("sha256")
    .update(JSON.stringify(stable(kit)))
    .digest("hex")
    .slice(0, 16);
