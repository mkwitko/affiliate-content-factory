import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureInput, SITUATION_CLASSES, type SceneDirectorFixtureFile } from "./fixtures.js";

const load = (split: "tuning" | "holdout"): SceneDirectorFixtureFile =>
  JSON.parse(
    readFileSync(new URL(`./${split}/fixtures.json`, import.meta.url), "utf8"),
  ) as SceneDirectorFixtureFile;
const files = [load("tuning"), load("holdout")];

describe("scene director fixtures", () => {
  it.each(files.map((file) => [file.split, file] as const))(
    "%s covers every situation class and every case kind",
    (split, file) => {
      expect(file.split).toBe(split);
      expect(new Set(file.fixtures.map((fixture) => fixture.class))).toEqual(
        new Set(SITUATION_CLASSES),
      );
      expect(new Set(file.fixtures.map((fixture) => fixture.case))).toEqual(
        new Set(["approved", "problematic", "adversarial"]),
      );
    },
  );

  it("keeps the held-out set separate from the tuning set", () => {
    const ids = files.flatMap((file) => file.fixtures.map((fixture) => fixture.id));
    const bodies = files.flatMap((file) => file.fixtures.map((fixture) => fixture.body));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("builds an approved script and the full cast for every fixture", () => {
    for (const file of files)
      for (const fixture of file.fixtures) {
        const input = fixtureInput(file, fixture);
        expect(input.script.status).toBe("approved");
        expect(input.script.body).toBe(fixture.body);
        expect(input.persona.map((character) => character.key)).toEqual(fixture.cast);
      }
  });

  it("marks every fixture's source", () => {
    for (const file of files)
      for (const fixture of file.fixtures)
        expect(fixture.source).toMatch(/^(synthetic|production:.+)$/);
  });
});
