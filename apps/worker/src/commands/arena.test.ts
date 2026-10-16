import { describe, expect, it } from "vitest";
import { arenaPairs, buildJudgePage, parseArenaRunSpec, specFromEditBench } from "./arena.js";

const spec = parseArenaRunSpec({
  task: "image.character_scene",
  champion: "local:flux-2-klein-4b",
  candidates: [
    { id: "local:flux-2-klein-4b", dir: "flux" },
    { id: "local:longcat-image-edit-turbo", dir: "longcat" },
  ],
  cases: [{ caseId: "casa_feed", brief: "Carla organiza a cozinha", references: [] }],
});

describe("arena command", () => {
  it("refuses a spec whose champion is not a candidate or whose dir escapes the run", () => {
    expect(() => parseArenaRunSpec({ ...spec, champion: "x" })).toThrow("arena_spec_invalid");
    expect(() =>
      parseArenaRunSpec({ ...spec, candidates: [{ id: "a", dir: "../etc" }, ...spec.candidates] }),
    ).toThrow("arena_spec_invalid");
  });

  it("asks every pair in both orders", () => {
    expect(arenaPairs(["a", "b", "c"])).toHaveLength(6);
  });

  it("hides model names on screen and skips pairs with a missing image", () => {
    const page = buildJudgePage(spec, new Set(["flux/casa_feed.png", "longcat/casa_feed.png"]), 7);
    const visible = page.replace(/data-[a-z]+="[^"]*"/g, "");
    expect(visible).not.toContain("longcat-image-edit-turbo");
    expect(page).toContain('data-left="local:');
    expect(buildJudgePage(spec, new Set(["flux/casa_feed.png"]), 7)).not.toContain("<section");
  });
});

describe("specFromEditBench", () => {
  it("builds briefs and character-then-product references from the corpus", () => {
    const built = specFromEditBench({
      task: "image.character_product",
      champion: "local:flux-2-klein-4b",
      candidates: [
        { id: "local:flux-2-klein-4b", dir: "klein" },
        { id: "local:mage-flow-edit-4b-turbo", dir: "mage" },
      ],
      caseIds: ["casa_feed"],
    });
    expect(built.cases[0]?.references?.map((r) => r.kind)).toEqual(["character", "product"]);
    expect(built.cases[0]?.brief).toContain("Carla");
    expect(() => specFromEditBench({ ...built, caseIds: ["nope"] } as never)).toThrow(
      "arena_case_unknown",
    );
  });
});

describe("arena spec paths", () => {
  it("keeps reference files inside the run's refs folder", () => {
    const bad = {
      ...spec,
      cases: [{ caseId: "c", brief: "b", references: [{ kind: "product", file: "../secret" }] }],
    };
    expect(() => parseArenaRunSpec(bad)).toThrow("arena_spec_invalid");
  });
});
