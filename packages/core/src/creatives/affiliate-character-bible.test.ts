import { describe, expect, it } from "vitest";
import { affiliateBibleClause, parseAffiliateBible } from "./affiliate-character-bible.js";
import { bibleFixture } from "./fixtures/affiliate-bible-fixture.js";

describe("parseAffiliateBible", () => {
  it("parses a valid bible and lower-cases hex", () => {
    expect(parseAffiliateBible(bibleFixture)?.palette).toEqual(["#aa0000", "#00bb00"]);
    expect(parseAffiliateBible(bibleFixture)?.voiceId).toBe("pf_dora");
  });
  it.each([
    ["absent", undefined],
    ["wrong version", { ...bibleFixture, version: 2 }],
    ["bad hex", { ...bibleFixture, palette: ["red"] }],
    ["missing field", { ...bibleFixture, hair: undefined }],
    ["non-string list item", { ...bibleFixture, poses: [1] }],
    ["array", []],
  ])("returns null for %s", (_name, value) => {
    expect(parseAffiliateBible(value)).toBeNull();
  });
});

describe("affiliateBibleClause", () => {
  const bible = parseAffiliateBible(bibleFixture);
  if (!bible) throw new Error("fixture");
  it("is deterministic and carries appearance, wardrobe, palette and forbidden changes", () => {
    const clause = affiliateBibleClause(bible);
    expect(clause).toBe(affiliateBibleClause(bible));
    expect(clause).toContain("fixture appearance");
    expect(clause).toContain("wardrobe fixture wardrobe");
    expect(clause).toContain("Palette #aa0000 #00bb00");
    expect(clause).toContain("Never change: hair colour; glasses");
  });
  it("keeps allowed expressions and poses, replaces disallowed ones with the first allowed", () => {
    expect(affiliateBibleClause(bible, { expression: "surprise", pose: "holding" })).toContain(
      "Expression: surprise. Pose: holding.",
    );
    expect(affiliateBibleClause(bible, { expression: "angry", pose: "dancing" })).toContain(
      "Expression: smile. Pose: pointing.",
    );
  });
});
