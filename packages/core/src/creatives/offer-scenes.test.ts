import { describe, expect, it } from "vitest";
import type { Asset } from "../assets/asset.js";
import { parseAffiliateBible } from "./affiliate-character-bible.js";
import { bibleFixture } from "./fixtures/affiliate-bible-fixture.js";
import { productVisualSpecFor } from "./in-scene-fidelity.js";
import {
  BACKDROP_LINE,
  colourName,
  compileOfferScenePrompt,
  expectedPeopleFor,
  MAX_OFFER_SCENE_ATTEMPTS,
  OFFER_SCENE_STYLE,
  offerSceneProgress,
  offerSceneSeed,
  offerSceneSlots,
  SCENE_COMPOSITION,
} from "./offer-scenes.js";

const title =
  "Estante Plástica 3 Prateleiras Multiuso Organização Casa Lavanderia Banheiro Cozinha";

describe("compileOfferScenePrompt", () => {
  const base = {
    storyWorld: "Small rented apartment, late afternoon light, palette sage green and beige",
    character: { name: "Carla", description: "35, curly brown hair in a bun, sage-green t-shirt" },
    moment: { headline: "Banheiro pequeno, R$ 89,90 e tudo no lugar", body: "Sobra 20% de espaço" },
    offerTitle: title,
    spec: productVisualSpecFor(title),
    colourNames: ["black", "black", "grey"],
  };
  const prompt = compileOfferScenePrompt({ ...base, canvas: "feed" });

  it("names the references in order and uses only title, counts and colours for the product", () => {
    expect(prompt.indexOf("first reference image")).toBeLessThan(
      prompt.indexOf("second reference image"),
    );
    expect(prompt).toContain("Estante Plástica 3 Prateleiras Multiuso Organização Casa");
    expect(prompt).toContain("made of plastic, main colours black and grey");
    expect(prompt).toContain("with exactly 3 shelves");
    expect(prompt).toContain("Carla: 35, curly brown hair");
    expect(prompt).toContain("Scene: Small rented apartment");
    expect(prompt).toContain(`Style: ${OFFER_SCENE_STYLE}.`);
  });

  it("draws the directed shot instead of the copy moment, one person exactly", () => {
    const directed = compileOfferScenePrompt({
      ...base,
      canvas: "feed",
      direction: { line: "Carla placing the product on the shelf, R$ 9,90 sticker.", people: 1 },
    });
    expect(directed).toContain("Carla placing the product on the shelf");
    expect(directed).toContain("Exactly one person, Carla. No other people");
    expect(directed).not.toContain("Moment, shown only through action");
    expect(directed).not.toContain("9,90");
    expect(expectedPeopleFor({ direction: { line: "x", people: 1 } })).toBe(1);
    expect(expectedPeopleFor({})).toBe(1);
  });

  it("keeps the sheet as a style guide only on a product-only shot", () => {
    const hero = compileOfferScenePrompt({
      ...base,
      canvas: "feed",
      direction: { line: "The product alone on a clean light surface.", people: 0 },
    });
    expect(hero).toContain("only a style guide: do not draw its person");
    expect(hero).not.toContain("The person from the first reference image");
    expect(hero).not.toContain("Carla");
    expect(hero).toContain("No people, no hands.");
    expect(hero).toContain("second reference image, unchanged");
    expect(hero).toContain(SCENE_COMPOSITION.feed);
    expect(expectedPeopleFor({ direction: { line: "x", people: 0 } })).toBe(0);
  });

  it("asks for an empty backdrop, never the product, on a composite slot", () => {
    const backdrop = compileOfferScenePrompt({
      ...base,
      canvas: "feed",
      direction: { line: "The product in its corner.", people: 0, backdrop: true },
    });
    expect(backdrop).toContain("Do not draw the product from the second reference image");
    expect(backdrop).toContain(BACKDROP_LINE);
    expect(backdrop).not.toContain("The product in its corner");
    expect(backdrop).not.toContain("unchanged");
    expect(backdrop).toContain("No people, no hands");
  });

  it("leaves room for the overlay text per canvas", () => {
    expect(prompt).toContain("upper third is calm plain background");
    expect(prompt).toContain(SCENE_COMPOSITION.feed);
    const story = compileOfferScenePrompt({ ...base, canvas: "story" });
    expect(story).toContain("keep the top 25% and bottom 25% calm plain background");
    expect(story).not.toContain(SCENE_COMPOSITION.feed);
  });

  it("appends the character bible clause, constrained to allowed poses, without product facts", () => {
    const bible = parseAffiliateBible(bibleFixture);
    const withBible = compileOfferScenePrompt({
      ...base,
      canvas: "feed",
      character: { ...base.character, bible },
      pose: "dancing",
    });
    expect(withBible).toContain("Character bible v1: fixture appearance");
    expect(withBible).toContain("Pose: pointing.");
    expect(withBible).toContain("Never change: hair colour; glasses.");
    expect(withBible.indexOf("Character bible")).toBeLessThan(withBible.indexOf("Scene:"));
    expect(
      compileOfferScenePrompt({
        ...base,
        canvas: "feed",
        character: { ...base.character, bible: null },
      }),
    ).toBe(prompt);
  });

  it("never carries a price, percentage or decimal number", () => {
    expect(prompt).not.toMatch(/R\$|89|20%|reais/);
    expect(prompt).toContain("Banheiro pequeno");
  });
});

describe("colourName", () => {
  it.each([
    [[10, 10, 10], "black"],
    [[250, 250, 250], "white"],
    [[128, 128, 128], "grey"],
    [[200, 30, 30], "red"],
    [[30, 60, 200], "blue"],
    [[40, 160, 60], "green"],
    [[120, 70, 30], "brown"],
    [[235, 220, 190], "beige"],
    [[245, 170, 200], "pink"],
  ] as const)("%j is %s", (rgb, name) => expect(colourName(rgb)).toBe(name));
});

const scene = (
  over: Partial<Asset> & { meta: Record<string, unknown> },
  id = Math.random().toString(16).slice(2),
): Asset =>
  ({
    id,
    state: "pending",
    ...over,
    metadata: { role: "offer_scene", contentItemId: "c", ...over.meta },
  }) as unknown as Asset;

describe("offerSceneProgress", () => {
  const slots = offerSceneSlots(2);

  it("covers every feed slide plus the story cover", () => {
    expect(slots).toEqual([
      { slideIndex: 1, canvas: "feed" },
      { slideIndex: 2, canvas: "feed" },
      { slideIndex: 1, canvas: "story" },
    ]);
  });

  it("separates passed, pending, retry and exhausted slots", () => {
    const progress = offerSceneProgress(slots, [
      scene(
        {
          state: "active",
          meta: { slideIndex: 1, canvas: "feed", attempt: 1, inSceneFidelity: { verdict: "pass" } },
        },
        "won",
      ),
      scene({ meta: { slideIndex: 2, canvas: "feed", attempt: 2 } }),
      ...Array.from({ length: MAX_OFFER_SCENE_ATTEMPTS }, (_, i) =>
        scene({ state: "archived", meta: { slideIndex: 1, canvas: "story", attempt: i + 1 } }),
      ),
    ]);
    expect(progress.passed.get("1:feed")).toBe("won");
    expect(progress.pending).toHaveLength(1);
    expect(progress.needed).toEqual([]);
    expect(progress.exhausted).toEqual([{ slideIndex: 1, canvas: "story" }]);
    expect(progress.complete).toBe(false);
  });

  it("asks for the next attempt after a block", () => {
    const progress = offerSceneProgress(slots, [
      scene({ state: "archived", meta: { slideIndex: 2, canvas: "feed", attempt: 1 } }),
    ]);
    expect(progress.needed.map((entry) => entry.attempt)).toEqual([1, 2, 1]);
  });

  it("seeds deterministically per item, slot and attempt", () => {
    const slot = { slideIndex: 1, canvas: "feed" as const };
    expect(offerSceneSeed("c", slot, 1)).toBe(offerSceneSeed("c", slot, 1));
    expect(offerSceneSeed("c", slot, 1)).not.toBe(offerSceneSeed("c", slot, 2));
    expect(offerSceneSeed("c", slot, 1)).toBeLessThan(2_147_483_647);
  });
});
