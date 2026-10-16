import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ExportEntry = Readonly<{ types: string; development: string; default: string }>;
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, ExportEntry>;
};

describe("providers package exports", () => {
  it("points every runtime entry at the file tsc emits (rootDir is the package root)", () => {
    const wrong = Object.entries(manifest.exports)
      .filter(
        ([, entry]) => entry.default !== `./dist/${entry.types.slice(2).replace(/\.ts$/, ".js")}`,
      )
      .map(([key]) => key);
    expect(wrong).toEqual([]);
  });
});
