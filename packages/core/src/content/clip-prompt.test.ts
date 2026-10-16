import { describe, expect, it } from "vitest";
import { CLIP_NEGATIVE_BLOCK, compileClipPrompt } from "./clip-prompt.js";

describe("compileClipPrompt", () => {
  it("joins style, scene and camera hint and appends the locked negative block", () => {
    const result = compileClipPrompt({
      clipPrompt: "A quiet kitchen at dawn, steam rising from a mug",
      stylePrefix: "warm painted look",
      cameraHint: "slow push in",
      forbiddenTerms: [],
    });
    expect(result).toEqual({
      ok: true,
      prompt: "warm painted look. A quiet kitchen at dawn, steam rising from a mug. slow push in",
      negativePrompt: CLIP_NEGATIVE_BLOCK,
    });
    expect(CLIP_NEGATIVE_BLOCK).toMatch(/logo/);
    expect(CLIP_NEGATIVE_BLOCK).toMatch(/readable text/);
    expect(CLIP_NEGATIVE_BLOCK).toMatch(/real people/);
  });
  it("refuses a prompt that names a denylisted brand, ignoring case and accents", () => {
    expect(compileClipPrompt({ clipPrompt: "a NIKE shoe on a desk", forbiddenTerms: [] })).toEqual({
      ok: false,
      reason: "brand_named:nike",
    });
  });
  it("refuses the offer title and offer brand facts", () => {
    expect(
      compileClipPrompt({
        clipPrompt: "close up of the Cadeira Ergonômica Pro on a desk",
        forbiddenTerms: ["cadeira ergonomica pro"],
      }),
    ).toEqual({ ok: false, reason: "brand_named:cadeira ergonomica pro" });
  });
  it("does not match a forbidden term inside another word", () => {
    expect(
      compileClipPrompt({ clipPrompt: "a snikers-free desk", forbiddenTerms: ["nik"] }).ok,
    ).toBe(true);
  });
  it("rejects an empty or over-long scene prompt", () => {
    expect(compileClipPrompt({ clipPrompt: "  ", forbiddenTerms: [] }).ok).toBe(false);
    expect(compileClipPrompt({ clipPrompt: "x".repeat(401), forbiddenTerms: [] }).ok).toBe(false);
  });
  it("lets a caller-supplied negative text extend but never replace the block", () => {
    const result = compileClipPrompt({ clipPrompt: "a park", forbiddenTerms: [] });
    expect(result.ok && result.negativePrompt.startsWith(CLIP_NEGATIVE_BLOCK)).toBe(true);
  });
  describe("INV-G1 distinctive title tokens", () => {
    const refused = (clipPrompt: string, offerTitle: string) =>
      compileClipPrompt({ clipPrompt, forbiddenTerms: [], offerTitle });
    it("refuses an alphanumeric model code from the title", () => {
      expect(refused("a sleek 1000xm5 on a desk", "Fone Sony WH-1000XM5 Preto")).toEqual({
        ok: false,
        reason: "brand_named:1000xm5",
      });
      expect(refused("hands holding the rx200", "Camera RX200 Compacta")).toEqual({
        ok: false,
        reason: "brand_named:rx200",
      });
    });
    it("refuses a capitalised distinctive word from the title", () => {
      expect(refused("a Stanley style bottle", "Garrafa Termica Stanley 950ml")).toEqual({
        ok: false,
        reason: "brand_named:stanley",
      });
    });
    it("allows stopwords and generic product nouns from the title", () => {
      expect(
        refused("a bottle and a chair for the desk with a kit", "Kit Garrafa e Cadeira Para Mesa")
          .ok,
      ).toBe(true);
    });
  });
});
