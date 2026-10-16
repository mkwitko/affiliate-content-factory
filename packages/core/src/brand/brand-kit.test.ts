import { describe, expect, it } from "vitest";
import {
  brandKitHash,
  brandTokens,
  DEFAULT_BRAND_KIT,
  DEFAULT_BRAND_TOKENS,
  mergeBrandKit,
} from "./brand-kit.js";

describe("mergeBrandKit", () => {
  it("applies layers in order while retaining default values", () => {
    const kit = mergeBrandKit(
      { brandName: "Example Shop" },
      { palette: { accent: "#22D3EE" }, nicheLabel: "tech" },
      { mark: { position: "top-right" } },
    );
    expect(kit.brandName).toBe("Example Shop");
    expect(kit.palette.accent).toBe("#22D3EE");
    expect(kit.palette.primary).toBe(DEFAULT_BRAND_KIT.palette.primary);
    expect(kit.mark.position).toBe("top-right");
    expect(kit.mark.safeMargin).toBe(DEFAULT_BRAND_KIT.mark.safeMargin);
  });

  it("ignores null layers and hashes deterministically", () => {
    expect(mergeBrandKit(null, undefined)).toEqual(DEFAULT_BRAND_KIT);
    expect(brandKitHash(mergeBrandKit({ palette: { accent: "#ffffff" } }))).toBe(
      brandKitHash(mergeBrandKit({ palette: { accent: "#ffffff" } })),
    );
    expect(brandKitHash(DEFAULT_BRAND_KIT)).toHaveLength(16);
  });

  it("rejects invalid palette colours", () => {
    expect(() => mergeBrandKit({ palette: { accent: "red" } })).toThrow(
      "brand_kit_invalid_colour:accent",
    );
  });

  it("merges token and dark/light overrides, hashes them, and validates them", () => {
    const kit = mergeBrandKit({
      palette: { dark: "#112233", light: "#ffeedd" },
      tokens: { radius: 20 },
    });
    expect(kit.palette.dark).toBe("#112233");
    expect(kit.tokens?.radius).toBe(20);
    expect(brandTokens(kit)).toEqual({ ...DEFAULT_BRAND_TOKENS, radius: 20 });
    expect(brandKitHash(kit)).not.toBe(brandKitHash(DEFAULT_BRAND_KIT));
    expect(brandTokens({})).toEqual(DEFAULT_BRAND_TOKENS);
    expect(() => mergeBrandKit({ palette: { dark: "navy" } })).toThrow(
      "brand_kit_invalid_colour:dark",
    );
    expect(() => mergeBrandKit({ tokens: { headlineMinPx: 99 } })).toThrow(
      "brand_kit_invalid_token:headlineMinPx",
    );
    expect(() => mergeBrandKit({ tokens: { radius: -1 } })).toThrow(
      "brand_kit_invalid_token:radius",
    );
  });
});
