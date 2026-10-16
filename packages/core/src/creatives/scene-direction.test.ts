import { describe, expect, it } from "vitest";
import {
  type ArtDirectionInput,
  artDirectionJsonSchema,
  buildArtDirectionMessages,
  defaultSceneLine,
  SHOT_FOR_TEMPLATE,
  sceneLineProblem,
  shotFor,
  validateSceneLines,
} from "./scene-direction.js";

const input: ArtDirectionInput = {
  product: "black plastic 3-shelf open rack",
  character: { name: "Carla", description: "35, curly brown hair in a bun, sage-green t-shirt" },
  otherNames: ["Bia", "Rafa"],
  world: "small kitchen and laundry corner in a rented apartment, late afternoon light",
  slides: [
    { index: 1, template: "hero", headline: "Organize sua lavanderia" },
    { index: 2, template: "benefit", headline: "Três prateleiras", body: "Cabe no canto" },
    { index: 3, template: "price", headline: "R$ 36,85" },
  ],
};

describe("shots", () => {
  it("draws people only where the slide needs them", () => {
    expect(SHOT_FOR_TEMPLATE.hero.people).toBe(1);
    expect(SHOT_FOR_TEMPLATE.benefit.kind).toBe("hands_feature");
    expect(SHOT_FOR_TEMPLATE.price.people).toBe(0);
    expect(SHOT_FOR_TEMPLATE.cta.kind).toBe("product_hero");
  });

  it("keeps the character only on the hero of a count-critical product", () => {
    expect(shotFor({ index: 1, template: "hero" }, true).kind).toBe("character_in_use");
    expect(shotFor({ index: 2, template: "benefit" }, true).kind).toBe("product_feature");
    expect(shotFor({ index: 3, template: "review" }, true).kind).toBe("product_in_place");
    expect(shotFor({ index: 5, template: "price" }, true).kind).toBe("product_hero");
    expect(shotFor({ index: 2, template: "benefit" }, false).kind).toBe("hands_feature");
    for (const template of ["benefit", "review", "price"] as const) {
      const shot = shotFor({ index: 2, template }, true);
      expect(shot.people).toBe(0);
      expect(sceneLineProblem(defaultSceneLine(shot, input), shot, input)).toBeNull();
    }
    const lines = validateSceneLines(
      { lines: [{ index: 2, scene: "Close-up of Carla's hands on the top shelf of the product" }] },
      { ...input, countCritical: true },
    );
    expect(lines[1]).toMatchObject({ source: "default", reason: "person_on_product_shot" });
  });

  it("keeps a small product off the floor and furniture on it", () => {
    const small = { ...input, countCritical: true, onFloor: false };
    const line = (scene: string) => validateSceneLines({ lines: [{ index: 3, scene }] }, small)[2];
    expect(
      line("The product rests on the floor against a beige wall, large and in focus."),
    ).toMatchObject({ source: "default", reason: "on_floor" });
    expect(
      line("The product sits on the kitchen counter, large and in focus, morning light."),
    ).toMatchObject({ source: "model" });
    expect(defaultSceneLine(SHOT_FOR_TEMPLATE.price, small)).toContain("on a clean counter");
    const furniture = { ...input, countCritical: true, onFloor: true };
    expect(
      validateSceneLines(
        {
          lines: [{ index: 3, scene: "The product stands on the kitchen table, loaded and tidy." }],
        },
        furniture,
      )[2],
    ).toMatchObject({ source: "default", reason: "off_floor" });
    expect(defaultSceneLine(SHOT_FOR_TEMPLATE.price, furniture)).toContain("on the floor");
    const messages = buildArtDirectionMessages(small);
    expect(messages[1]?.content).toContain("never on the floor");
  });

  it("gives every template a default that passes its own validation", () => {
    for (const shot of Object.values(SHOT_FOR_TEMPLATE))
      expect(sceneLineProblem(defaultSceneLine(shot, input), shot, input)).toBeNull();
  });
});

describe("sceneLineProblem", () => {
  const hero = SHOT_FOR_TEMPLATE.hero;
  const price = SHOT_FOR_TEMPLATE.price;
  it.each([
    [42, "not_string"],
    ["short", "length"],
    ["x".repeat(301), "length"],
    ["Carla places the product, 89,90 scratched on the top shelf", "digit"],
    ["Carla places the product beside the 1080 washing machine", "digit"],
    ["Carla smiles at the product, a price tag hanging from the top shelf", "text_or_price"],
    ["Carla and her friends arrange towels on the product in the bathroom", "extra_person"],
    ["Carla and Bia arrange towels on the product in the bathroom", "extra_person"],
    ["Carla checks her reflection while the product stands beside the sink", "extra_person"],
  ])("rejects %j as %s", (line, reason) => {
    expect(sceneLineProblem(line, hero, input)).toBe(reason);
  });

  it("rejects any person on a product-only shot", () => {
    expect(sceneLineProblem("Carla's hands set the product on a clean counter", price, input)).toBe(
      "person_on_product_shot",
    );
  });

  it("accepts a concrete one-person moment", () => {
    expect(
      sceneLineProblem(
        "Carla slides the empty product into the gap beside the washing machine, laundry basket at her feet",
        hero,
        input,
      ),
    ).toBeNull();
  });
});

describe("validateSceneLines", () => {
  it("replaces a repeated model line with the slot's default", () => {
    const same = "The product alone on a beige surface, calm white space above it in a quiet room";
    const lines = validateSceneLines(
      {
        lines: [
          { index: 2, scene: same },
          { index: 3, scene: ` ${same.toUpperCase()} ` },
        ],
      },
      { ...input, countCritical: true },
    );
    expect(lines[1]).toMatchObject({ source: "model" });
    expect(lines[2]).toMatchObject({ source: "default", reason: "duplicate" });
  });

  it("keeps valid model lines and fills every gap with the slide's default", () => {
    const lines = validateSceneLines(
      {
        lines: [
          {
            index: 1,
            scene: "Carla slides the empty product into the corner beside the washing machine",
          },
          { index: 1, scene: "Carla again, a second version of the first slide" },
          { index: 2, scene: "Close-up of Carla's hands with 3 shelves" },
          { index: 9, scene: "An extra slide that does not exist in the deck at all" },
        ],
      },
      input,
    );
    expect(lines.map((l) => [l.index, l.source, l.reason])).toEqual([
      [1, "model", undefined],
      [2, "model", undefined],
      [3, "default", "missing"],
    ]);
  });

  it("uses every default when the answer is unusable", () => {
    for (const raw of [null, "text", { lines: "x" }, { other: [] }])
      expect(validateSceneLines(raw, input).every((l) => l.source === "default")).toBe(true);
  });
});

describe("request", () => {
  it("asks for one scene line per slide with the slide's shot", () => {
    const schema = artDirectionJsonSchema(input);
    expect(schema.properties.lines.minItems).toBe(3);
    expect(schema.properties.lines.maxItems).toBe(3);
    const user = buildArtDirectionMessages(input).at(-1)?.content ?? "";
    expect(user).toContain("Slide 3 (price): product alone");
    expect(user).toContain("Carla");
  });
});
