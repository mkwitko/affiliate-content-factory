import { describe, expect, it } from "vitest";
import { ARCHETYPES, readCharacterBible, rigBuildFor } from "./character-bible.js";
import { readExplainerContext } from "./explainer-context.js";
import { BIBLE_CAST } from "./fixtures/cast/bible-cast.js";
import { poseAngles, renderStickmanFrame } from "./rigs/stick-v1.js";

const palette = { line: "#161616", fill: "#ffffff", accent: "#ff5a36" };
const figure = (build?: ReturnType<typeof rigBuildFor>) =>
  renderStickmanFrame({
    angles: poseAngles("walking"),
    expression: "happy",
    palette,
    x: 540,
    baselineY: 1180,
    extremities: true,
    ...(build ? { build } : {}),
  });
const bible = (archetype: string, head = "circle") =>
  readCharacterBible({ version: 1, role: "lead", body: { archetype, head } });

describe("character bible", () => {
  it("draws today's rig for an average build with a round head", () => {
    const average = bible("average");
    if (!average) throw new Error("bible rejected");
    expect(figure(rigBuildFor(average))).toBe(figure());
  });

  it("keeps each archetype's figure stable", () => {
    const figures = Object.fromEntries(
      ARCHETYPES.map((archetype) => {
        const read = bible(archetype, archetype === "average" ? "circle" : "oval_tall");
        return [archetype, read ? figure(rigBuildFor(read)) : ""];
      }),
    );
    expect(new Set(Object.values(figures)).size).toBe(ARCHETYPES.length);
    expect(figures).toMatchSnapshot();
  });

  it("rejects a bible without a known role, archetype or head", () => {
    expect(
      readCharacterBible({
        version: 1,
        role: "boss",
        body: { archetype: "average", head: "circle" },
      }),
    ).toBeNull();
    expect(
      readCharacterBible({
        version: 1,
        role: "lead",
        body: { archetype: "giant", head: "circle" },
      }),
    ).toBeNull();
    expect(bible("average")?.body.scale).toBe(1);
  });

  it("is read from the stored cast", () => {
    const cast = readExplainerContext({
      kind: "media",
      context: { characters: BIBLE_CAST },
    })?.characters;
    expect(cast?.every((c) => c.bible !== undefined)).toBe(true);
    expect(cast?.find((c) => c.key === "leo")?.bible?.body.scale).toBe(0.82);
  });
});
