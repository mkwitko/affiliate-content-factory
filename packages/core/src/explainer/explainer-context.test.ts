import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_PALETTE,
  readExplainerContext,
  scenePaletteFor,
} from "./explainer-context.js";

const alex = {
  key: "alex",
  name: "Alex",
  role: "main",
  description: "explainer",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#1b1b1b", fill: "#ffffff", accent: "#ff5a36" },
};

describe("readExplainerContext", () => {
  it("is null for affiliate niches", () => {
    expect(readExplainerContext({ kind: "affiliate", context: { characters: [alex] } })).toBeNull();
  });

  it("applies defaults and keeps rigged characters only", () => {
    const ctx = readExplainerContext({
      kind: "media",
      context: { characters: [{ name: "Carla", description: "affiliate cast" }, alex] },
    });
    expect(ctx?.format).toBe("short");
    expect(ctx?.targetSeconds).toEqual({ min: 20, max: 60 });
    expect(ctx?.captionStyle).toEqual({ maxWords: 3 });
    expect(ctx?.musicPolicy).toBe("none");
    expect(ctx?.characters.map((c) => c.key)).toEqual(["alex"]);
  });

  it("keeps a character's and the niche's Kokoro voice ids and drops malformed ones", () => {
    const ctx = readExplainerContext({
      kind: "media",
      context: {
        voiceId: "pf_dora",
        characters: [
          { ...alex, voiceId: "pm_alex" },
          { ...alex, key: "bia", voiceId: "Not A Voice" },
        ],
      },
    });
    expect(ctx?.voiceId).toBe("pf_dora");
    expect(ctx?.characters.map((c) => c.voiceId)).toEqual(["pm_alex", undefined]);
  });

  it("reads explicit explainer settings", () => {
    const ctx = readExplainerContext({
      kind: "media",
      context: {
        explainer: {
          format: "long",
          targetSeconds: { min: 180, max: 600 },
          captionStyle: { maxWords: 2 },
          musicPolicy: "optional",
        },
      },
    });
    expect(ctx).toMatchObject({
      format: "long",
      targetSeconds: { min: 180, max: 600 },
      captionStyle: { maxWords: 2 },
      musicPolicy: "optional",
      characters: [],
    });
  });

  it("works without any context", () => {
    expect(readExplainerContext({ kind: "media", context: null })?.characters).toEqual([]);
  });
});

describe("wardrobe", () => {
  it("keeps a character's wardrobe from the closed catalog and drops unknown or empty pieces", () => {
    const wardrobeOf = (wardrobe: unknown) =>
      readExplainerContext({ kind: "media", context: { characters: [{ ...alex, wardrobe }] } })
        ?.characters[0]?.wardrobe;
    expect(
      wardrobeOf({
        hair: { style: "bun", colour: "#222222" },
        top: { style: "cape", colour: "#ff0000" },
        bottoms: { style: "skirt", colour: "red" },
        head: "big",
      }),
    ).toEqual({ hair: { style: "bun", colour: "#222222" }, head: "big" });
    expect(
      wardrobeOf({
        top: { style: "hoodie", colour: "#2F6FDB" },
        bottoms: { style: "pants", colour: "#333333" },
        head: "standard",
      }),
    ).toEqual({
      top: { style: "hoodie", colour: "#2F6FDB" },
      bottoms: { style: "pants", colour: "#333333" },
    });
    expect(wardrobeOf({})).toBeUndefined();
    expect(wardrobeOf("hoodie")).toBeUndefined();
  });
});

describe("niche art style", () => {
  it("reads the niche art style from the closed list", () => {
    const style = (value: unknown) =>
      readExplainerContext({ kind: "media", context: { explainer: { style: value } } })?.style;
    expect(style("sketch_watercolor")).toBe("sketch_watercolor");
    expect(style("flat_cartoon")).toBe("flat_cartoon");
    expect(style("oil_painting")).toBeUndefined();
  });
});

describe("scenePaletteFor", () => {
  it("uses the light explainer palette by default", () => {
    expect(scenePaletteFor({ context: null })).toEqual(DEFAULT_SCENE_PALETTE);
  });
  it("takes the niche brand kit accent", () => {
    expect(
      scenePaletteFor({ context: { brandKit: { palette: { accent: "#123456" } } } }).accent,
    ).toBe("#123456");
  });
  it("ignores a malformed accent", () => {
    expect(scenePaletteFor({ context: { brandKit: { palette: { accent: "red" } } } }).accent).toBe(
      DEFAULT_SCENE_PALETTE.accent,
    );
  });
});
