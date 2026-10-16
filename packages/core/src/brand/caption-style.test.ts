import { describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  contrastRatio,
  readCaptionThemeConfig,
  resolveCaptionTheme,
} from "./caption-style.js";
import { mergeBrandKit } from "./brand-kit.js";

const base = { canvas: "portrait" as const };

describe("resolveCaptionTheme", () => {
  it("defaults to word_pop with today's margin", () => {
    const theme = resolveCaptionTheme(base);
    expect(theme).toMatchObject({ id: "word_pop", marginV: 576, marginR: 160, font: "Inter" });
    expect(theme.fallback).toBeUndefined();
  });

  it("applies a preset, then niche overrides", () => {
    const theme = resolveCaptionTheme({
      ...base,
      niche: { context: { captionTheme: { preset: "karaoke", maxWords: 2, size: 72 } } },
    });
    expect(theme).toMatchObject({
      id: "karaoke",
      highlightMode: "karaoke_fill",
      maxWords: 2,
      size: 72,
    });
  });

  it("uses brand colours only when opted in", () => {
    const brandKit = mergeBrandKit({ palette: { accent: "#FF8800", text: "#F0F0F0" } });
    const off = resolveCaptionTheme({ ...base, brandKit });
    expect(off.highlightColor).toBe(CAPTION_PRESETS.word_pop.highlightColor);
    const on = resolveCaptionTheme({
      ...base,
      brandKit,
      niche: { context: { captionTheme: { useBrandColors: true } } },
    });
    expect(on).toMatchObject({ highlightColor: "#FF8800", baseColor: "#F0F0F0" });
  });

  it("lets the visual language profile win on size and grouping", () => {
    const theme = resolveCaptionTheme({
      ...base,
      niche: { context: { captionTheme: { size: 50, maxWords: 4 } } },
      visualLanguage: { type: { captionPx: 80, maxWordsChunk: 2 } },
    });
    expect(theme).toMatchObject({ size: 80, maxWords: 2 });
  });

  it("clamps margins into the safe zone per canvas and channel", () => {
    const low = { niche: { context: { captionTheme: { position: "lower_third" as const } } } };
    expect(resolveCaptionTheme({ ...base, ...low }).marginV).toBeGreaterThanOrEqual(384);
    expect(resolveCaptionTheme({ ...base, ...low, channelKind: "instagram_reels" }).marginR).toBe(
      160,
    );
    expect(resolveCaptionTheme({ canvas: "landscape", ...low }).marginR).toBe(80);
    expect(resolveCaptionTheme({ canvas: "landscape", ...low }).marginV).toBeGreaterThanOrEqual(
      108,
    );
  });

  it("falls back to word_pop when contrast is below 4.5", () => {
    const theme = resolveCaptionTheme({
      ...base,
      niche: {
        context: {
          captionTheme: { preset: "karaoke", baseColor: "#222222", surfaceColor: "#000000" },
        },
      },
    });
    expect(theme).toMatchObject({ id: "word_pop", fallback: true });
  });

  it("keeps installed fonts and ignores unknown ones", () => {
    const font = (value: string) =>
      resolveCaptionTheme({ ...base, niche: { context: { captionTheme: { font: value } } } }).font;
    expect(font("Montserrat")).toBe("Montserrat");
    expect(font("Bebas Neue")).toBe("Bebas Neue");
    expect(font("Comic Sans")).toBe("Inter");
  });
});

describe("readCaptionThemeConfig", () => {
  it("keeps valid fields and drops invalid ones", () => {
    expect(
      readCaptionThemeConfig({
        captionTheme: { preset: "clean", baseColor: "red", size: 500, maxWords: 2, bogus: 1 },
      }),
    ).toEqual({ preset: "clean", maxWords: 2 });
    expect(readCaptionThemeConfig(null)).toBeUndefined();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
  });
});
