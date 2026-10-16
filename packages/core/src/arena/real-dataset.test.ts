import { describe, expect, it } from "vitest";
import { REAL_PRODUCTS } from "./fixtures/real-products.js";
import {
  artDirectionInputFromReal,
  copyCaseFromReal,
  realProductsInterleaved,
  sceneCaseFromReal,
  slideSceneCaseFromReal,
} from "./real-dataset.js";

describe("real-product arena dataset", () => {
  it("has unique ids, a photo and verified price for every product, and covers the hard cases", () => {
    expect(new Set(REAL_PRODUCTS.map((p) => p.id)).size).toBe(REAL_PRODUCTS.length);
    for (const p of REAL_PRODUCTS) {
      expect(p.photo).toMatch(/^(https:\/\/http2\.mlstatic\.com\/|asset:[0-9a-f-]{36}$)/);
      expect(p.facts.find((f) => f.key === "current_price")?.verified).toBe(true);
    }
    const tags = new Set(REAL_PRODUCTS.flatMap((p) => p.hard));
    for (const tag of [
      "transparent",
      "reflective",
      "thin_cable",
      "packaging_text",
      "count_matters",
    ])
      expect(tags.has(tag), tag).toBe(true);
  });

  it("interleaves niches so the first three cover casa, beleza and tech", () => {
    expect(
      realProductsInterleaved()
        .slice(0, 3)
        .map((p) => p.niche),
    ).toEqual(["casa", "beleza", "tech"]);
  });

  it("builds copy input from listing facts only and a scene prompt from the listing title", () => {
    const p = REAL_PRODUCTS.find((x) => x.id === "tech-cabo-usbc");
    if (!p) throw new Error("fixture missing");
    const copy = copyCaseFromReal(p);
    expect(copy.sourceFactKeys).toEqual(p.facts.map((f) => f.key));
    const scene = sceneCaseFromReal(p);
    expect(scene.references[1]).toBe(p.photo);
    expect(scene.prompt).toContain(
      "A long braided USB-C to USB-C cable, exactly as in the second reference image.",
    );
    expect(scene.prompt).toContain("Rafa");
  });

  it("draws each slide as its own moment, as production does, without prices", () => {
    const p = REAL_PRODUCTS.find((x) => x.id === "tech-cabo-usbc");
    if (!p) throw new Error("fixture missing");
    const one = slideSceneCaseFromReal(p, { headline: "Carrega rápido", body: "Por R$ 29,90" });
    const two = slideSceneCaseFromReal(p, { headline: "Cabo longo de 2 m" });
    expect(one.prompt).not.toBe(two.prompt);
    expect(one.prompt).toContain("never as written words: Carrega rápido");
    expect(one.prompt).not.toContain("29,90");
    expect(one.prompt).toContain("exactly as in the second reference image.");
    expect(one.references).toEqual(sceneCaseFromReal(p).references);
  });
  it("builds the art-direction input from the listing and the niche cast", () => {
    const p = REAL_PRODUCTS.find((x) => x.id === "tech-cabo-usbc");
    if (!p) throw new Error("fixture missing");
    const input = artDirectionInputFromReal(p, [{ index: 1, template: "hero", headline: "Oi" }]);
    expect(input.character.name).toBe("Rafa");
    expect(input.otherNames).toEqual(["Carla", "Bia"]);
    expect(input.world).not.toMatch(/^Scene:/);
    expect(input.product).toBe(p.visual);
  });

  it("draws a scene line with one person, or the product alone", () => {
    const p = REAL_PRODUCTS.find((x) => x.id === "tech-cabo-usbc");
    if (!p) throw new Error("fixture missing");
    const one = slideSceneCaseFromReal(
      p,
      { headline: "x" },
      { line: "Rafa plugs the product into his laptop", people: 1 },
    );
    expect(one.prompt).toContain("Rafa plugs the product into his laptop");
    expect(one.prompt).toContain(
      "Exactly one person, Rafa. No other people, no duplicates, no reflections.",
    );
    expect(one.prompt).not.toContain("never as written words");
    const none = slideSceneCaseFromReal(
      p,
      { headline: "x" },
      { line: "The product alone on a desk", people: 0 },
    );
    expect(none.prompt).toContain("only a style guide: do not draw its person");
    expect(none.prompt).toContain("No people, no hands.");
    expect(none.prompt).not.toContain("same face, hair and clothes");
  });
});
