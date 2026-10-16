import { DEFAULT_BRAND_KIT } from "@money-maker/core/brand/brand-kit";
import type { SubjectBox } from "@money-maker/core/creatives/in-scene-fidelity";
import { type CanvasKind, templateFor } from "@money-maker/core/creatives/templates";
import { describe, expect, it } from "vitest";
import { disclosureTextColour, inSceneOverlay } from "./in-scene-overlay.js";

const svgFor = async (canvas: CanvasKind, total: number, extra = {}) => {
  const [W, H] = canvas === "feed" ? [1080, 1350] : [1080, 1920];
  const out = await inSceneOverlay(
    {
      canvas,
      template: templateFor("hero", canvas),
      spec: {
        index: 1,
        total,
        template: "hero",
        headline: "Um titulo",
        disclosure: "#publi",
        claims: [],
      },
      brand: DEFAULT_BRAND_KIT,
      product: { inScene: true },
      background: { png: new Uint8Array() },
      ...extra,
    },
    W,
    H,
  );
  return String(out.layers[0]?.input);
};
const sizeOf = (svg: string, text: string): number =>
  Number(new RegExp(`font-size="(\\d+)"[^>]*>${text}<`).exec(svg)?.[1]);

describe("in-scene overlay presets", () => {
  it("draws no counter for a single image and one for carousels", async () => {
    expect(await svgFor("feed", 1)).not.toContain("1/1");
    expect(await svgFor("feed", 5)).toContain("1/5");
  });
  it("draws the disclosure tag at least 28 px on a 1080 px canvas", async () => {
    expect(sizeOf(await svgFor("feed", 1), "#publi")).toBeGreaterThanOrEqual(28);
  });
  it("keeps story content out of the UI-blocked top and bottom bands", async () => {
    const svg = await svgFor("story", 5);
    const ys = [...svg.matchAll(/<text [^>]*y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThan(1920 * 0.14);
    expect(Math.max(...ys)).toBeLessThan(1920 * 0.8);
  });
  it("picks a readable disclosure colour or fails closed", () => {
    expect(disclosureTextColour("#000000", 4.5)).toBe("#ffffff");
    expect(disclosureTextColour("#ffffff", 4.5)).toBe("#000000");
    expect(() => disclosureTextColour("#808080", 21)).toThrow("layout_failed:disclosure_contrast");
  });
  it("draws the price pill from verified price facts, not the badge copy", async () => {
    const svg = await svgFor("feed", 1, {
      price: {
        current: { amountMinor: 3685, currency: "BRL" },
        original: { amountMinor: 4990, currency: "BRL" },
        discountPct: 26,
        source: { factKeys: ["current_price", "list_price"], snapshotId: "s", verifiedAt: "x" },
      },
    });
    expect(svg).toContain("De R$ 49,90");
    expect(svg).toContain("R$ 36,85");
  });
});

describe("in-scene overlay around subjects", () => {
  const FEED_SOURCE = { w: 512, h: 640 };
  const overlay = (subjects?: readonly SubjectBox[]) =>
    inSceneOverlay(
      {
        canvas: "feed",
        template: templateFor("hero", "feed"),
        spec: {
          index: 1,
          total: 1,
          template: "hero",
          headline: "Toalha e shampoo\nem cima da pia?",
          body: "Estante de 3 prateleiras.",
          badge: "R$ 36,85",
          disclosure: "#publi",
          claims: [],
        },
        brand: DEFAULT_BRAND_KIT,
        product: { inScene: true },
        background: { png: new Uint8Array() },
        ...(subjects ? { subjects } : {}),
      },
      1080,
      1350,
      FEED_SOURCE,
    );
  const svgOf = async (subjects?: readonly SubjectBox[]) =>
    String((await overlay(subjects)).layers[0]?.input);

  it("draws the same layout when no subject is known or none is in the way", async () => {
    const plain = await svgOf();
    expect(await svgOf([])).toBe(plain);
    expect(await svgOf([{ kind: "face", box: [700, 450, 850, 600] }])).toBe(plain);
    expect((await overlay()).subjectLayout).toBeUndefined();
  });

  it("moves the headline off a face at the top", async () => {
    const plain = await overlay();
    const face = { kind: "face", box: [300, 120, 700, 300] } as const;
    const out = await overlay([face]);
    const headline = out.boxes.headline;
    const faceTop = 0.12 * 1350;
    const faceBottom = 0.3 * 1350;
    expect(out.subjectLayout?.collisions).toEqual([]);
    expect(headline && plain.boxes.headline && headline.y).toBeGreaterThan(
      plain.boxes.headline?.y ?? 0,
    );
    expect(headline && (headline.y >= faceBottom || headline.y + headline.h <= faceTop)).toBe(true);
  });

  it("puts the headline on a white card and reports collisions when nothing is clear", async () => {
    const out = await overlay([{ kind: "face", box: [0, 0, 1000, 1000] }]);
    expect(out.subjectLayout?.top.card).toBe(true);
    expect(out.subjectLayout?.collisions.some((hit) => hit.kind === "face")).toBe(true);
    expect(String(out.layers[0]?.input)).toMatch(/<rect [^>]*fill="#fff" filter/);
  });
});

describe("in-scene layout family by plan role", () => {
  const draw = (template: "hero" | "benefit" | "price" | "cta") =>
    inSceneOverlay(
      {
        canvas: "story",
        template: templateFor(template, "story"),
        spec: {
          index: 2,
          total: 5,
          template,
          headline: "Cabe tudo\nno cantinho",
          body: "Estante de 3 prateleiras.",
          badge: "R$ 36,85",
          disclosure: "#publi",
          claims: [],
        },
        cta: "Link na bio",
        brand: DEFAULT_BRAND_KIT,
        product: { inScene: true },
        background: { png: new Uint8Array() },
      },
      1080,
      1920,
    );

  it("shouts the hook on the cover and reads as a caption in the middle", async () => {
    const [cover, caption] = await Promise.all([draw("hero"), draw("benefit")]);
    expect(caption.headlineFontSize).toBeLessThan(cover.headlineFontSize);
  });

  it("makes the price the largest pill on the price slide and the action on the last", async () => {
    const [caption, price, action] = await Promise.all([
      draw("benefit"),
      draw("price"),
      draw("cta"),
    ]);
    expect(price.boxes.price?.h ?? 0).toBeGreaterThan((caption.boxes.price?.h ?? 0) * 1.3);
    expect(action.boxes.cta?.h ?? 0).toBeGreaterThan((caption.boxes.cta?.h ?? 0) * 1.2);
  });
});

describe("in-scene headline stays on the canvas", () => {
  it("wraps a heavy cover headline before its ink reaches the edge (porta-tempero 2026-10-09)", async () => {
    const { inkBoxes } = await import("./text-ink.js");
    const out = await inSceneOverlay(
      {
        canvas: "feed",
        template: templateFor("hero", "feed"),
        spec: {
          index: 1,
          total: 5,
          template: "hero",
          headline: "Tem medo de comprar e não caber na sua cozinha?",
          claims: [],
        },
        brand: DEFAULT_BRAND_KIT,
        product: { inScene: true },
        background: { png: new Uint8Array() },
      },
      1080,
      1350,
    );
    const ink = await inkBoxes(String(out.layers[0]?.input), { w: 1080, h: 1350 });
    expect(ink.headline).toBeDefined();
    expect((ink.headline?.x ?? 0) + (ink.headline?.w ?? 0)).toBeLessThanOrEqual(1080 - 40);
  }, 30_000);
});
