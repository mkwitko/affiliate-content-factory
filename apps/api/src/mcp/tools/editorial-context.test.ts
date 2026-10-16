import { describe, expect, it } from "vitest";
import {
  brandContextSchema,
  channelContextSchema,
  nicheContextSchema,
  withContextSizeLimit,
} from "./editorial-context.js";

describe("editorial context schemas", () => {
  it("rejects an unknown key", () => {
    expect(brandContextSchema.safeParse({ mission: "x", unknown: "y" }).success).toBe(false);
  });

  it("rejects a payload larger than 16KB", () => {
    const bounded = withContextSizeLimit(brandContextSchema);
    // Each field stays within its own max length (schema-valid on its own); only the
    // combined UTF-8 byte size (multi-byte characters) pushes the total over the 16KB cap.
    const maxedField = Array.from({ length: 20 }, () => "文".repeat(200));
    expect(bounded.safeParse({ principles: maxedField, editorialRules: maxedField }).success).toBe(
      false,
    );
  });

  it("accepts a well-formed, bounded payload", () => {
    const bounded = withContextSizeLimit(brandContextSchema);
    expect(
      bounded.safeParse({ mission: "Ajudar compradores a decidir melhor.", cta: "Compre agora" })
        .success,
    ).toBe(true);
  });

  it("accepts a story world with main, secondary and pet characters", () => {
    const characters = [
      { name: "Carla", role: "main", description: "Protagonista." },
      { name: "Theo", role: "secondary", description: "Filho de 7 anos." },
      { name: "Paçoca", role: "pet", description: "Vira-lata caramelo." },
      ...Array.from({ length: 5 }, (_unused, index) => ({
        name: `Vizinho ${index}`,
        role: "secondary",
        description: "Aparece às vezes.",
      })),
    ];
    expect(
      nicheContextSchema.safeParse({ storyWorld: "Apartamento em Campinas.", characters }).success,
    ).toBe(true);
    expect(
      nicheContextSchema.safeParse({
        characters: [...characters, { name: "Extra", description: "Nono." }],
      }).success,
    ).toBe(false);
    expect(
      nicheContextSchema.safeParse({
        characters: [{ name: "Carla", role: "villain", description: "x" }],
      }).success,
    ).toBe(false);
  });

  it("validates the affiliate character bible", () => {
    const affiliateBible = {
      version: 1,
      appearance: "fixture",
      proportions: "fixture",
      hair: "fixture",
      wardrobe: "fixture",
      palette: ["#aabbcc"],
      expressions: ["smile"],
      poses: ["pointing"],
      forbiddenChanges: ["hair colour"],
    };
    const ctx = (bible: unknown) => ({
      characters: [{ name: "Carla", role: "main", description: "x", affiliateBible: bible }],
    });
    expect(nicheContextSchema.safeParse(ctx(affiliateBible)).success).toBe(true);
    expect(nicheContextSchema.safeParse(ctx({ ...affiliateBible, version: 2 })).success).toBe(
      false,
    );
    expect(nicheContextSchema.safeParse(ctx({ ...affiliateBible, palette: ["red"] })).success).toBe(
      false,
    );
    expect(nicheContextSchema.safeParse(ctx({ ...affiliateBible, extra: 1 })).success).toBe(false);
  });

  it("validates the channel slideCount shape", () => {
    expect(channelContextSchema.safeParse({ slideCount: { min: 3, max: 10 } }).success).toBe(true);
    expect(channelContextSchema.safeParse({ slideCount: { min: 0, max: 10 } }).success).toBe(false);
  });

  it("accepts valid brand kit overrides and rejects invalid colours", () => {
    expect(
      brandContextSchema.safeParse({ brandKit: { palette: { accent: "#22D3EE" } } }).success,
    ).toBe(true);
    expect(
      nicheContextSchema.safeParse({ brandKit: { mark: { position: "top-right" } } }).success,
    ).toBe(true);
    expect(
      channelContextSchema.safeParse({ brandKit: { palette: { accent: "red" } } }).success,
    ).toBe(false);
  });
});

describe("explainer niche context", () => {
  it("accepts a cast wardrobe and a niche art style from the closed catalogs", () => {
    const character = {
      name: "Bia",
      description: "Friend.",
      key: "bia",
      rigId: "stick-v1",
      rigVersion: 1,
      palette: { line: "#111111", fill: "#ffffff", accent: "#2f6fdb" },
    };
    const accepts = (wardrobe: unknown, style = "sketch_watercolor") =>
      nicheContextSchema.safeParse({
        characters: [{ ...character, wardrobe }],
        explainer: { style },
      }).success;
    expect(
      accepts({
        hair: { style: "bun", colour: "#222222" },
        top: { style: "hoodie", colour: "#2f6fdb" },
        bottoms: { style: "skirt", colour: "#333333" },
        head: "big",
      }),
    ).toBe(true);
    expect(accepts({ hair: { style: "mohawk", colour: "#222222" } })).toBe(false);
    expect(accepts({ top: { style: "shirt", colour: "blue" } })).toBe(false);
    expect(accepts({ top: { style: "shirt", colour: "#0000ff" }, cape: true })).toBe(false);
    expect(accepts(undefined, "oil_painting")).toBe(false);
  });

  it("accepts rigged characters and an explainer block", () => {
    expect(
      nicheContextSchema.safeParse({
        characters: [
          {
            key: "alex",
            name: "Alex",
            role: "main",
            description: "Main explainer.",
            rigId: "stick-v1",
            rigVersion: 1,
            palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
            accessory: "glasses",
          },
        ],
        explainer: {
          format: "short",
          targetSeconds: { min: 20, max: 60 },
          captionStyle: { maxWords: 3 },
          musicPolicy: "none",
          series: [{ key: "how_money_works", name: "How Money Works", diagramRequired: true }],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an inverted target duration", () => {
    expect(
      nicheContextSchema.safeParse({ explainer: { targetSeconds: { min: 60, max: 20 } } }).success,
    ).toBe(false);
  });

  it("rejects an unknown rig", () => {
    expect(
      nicheContextSchema.safeParse({
        characters: [{ name: "A", description: "B", rigId: "stick-v9" }],
      }).success,
    ).toBe(false);
  });

  it("accepts the Cost Curious packaging profile and rejects a bad pattern id", () => {
    const profile = {
      tagline: "Why things cost what they cost.",
      forbiddenPhrases: ["game changer"],
      cadence: { longFormPerWeek: 3, shortsPerLongForm: 3 },
      packaging: {
        maxOverlayWords: 4,
        titlePatterns: [{ id: "CC10", label: "CROSS_SUBSIDY", example: "Why X" }],
        hookPatterns: [{ id: "HK1", label: "RESTATE_AND_RAISE" }],
        thumbnailRules: ["One focal point"],
      },
    };
    expect(nicheContextSchema.safeParse(profile).success).toBe(true);
    const bad = { packaging: { titlePatterns: [{ id: "cc1", label: "X" }] } };
    expect(nicheContextSchema.safeParse(bad).success).toBe(false);
    expect(
      nicheContextSchema.safeParse({ cadence: { longFormPerWeek: 15, shortsPerLongForm: 1 } })
        .success,
    ).toBe(false);
  });
});
