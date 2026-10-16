import { describe, expect, it } from "vitest";
import {
  BEAT_TEMPLATES,
  type BeatTemplateId,
  buildEpisodePlan,
  lintEpisode,
  lintSeriesPlants,
  type EpisodeSpec,
} from "./story.js";
import { STORY_FIXTURES, fixtureIdea } from "./fixtures.js";

describe("beat templates", () => {
  it.each(Object.keys(BEAT_TEMPLATES) as BeatTemplateId[])("%s builds a lint-clean plan", (t) => {
    const plan = buildEpisodePlan({
      id: "e1",
      seriesId: "s1",
      idea: fixtureIdea({ template: t }),
      hook: "Nobody checks the back shelf",
      targetSec: 60,
      targetAudience: "general",
      contentIntent: "story",
    });
    expect(lintEpisode(plan)).toEqual([]);
    expect(plan.beats[0]?.kind).toBe("hook");
    expect(plan.beats.slice(1).every((b) => b.link !== undefined)).toBe(true);
    expect(plan.beats.reduce((s, b) => s + b.targetSec, 0)).toBeCloseTo(60, 0);
  });
  it("fingerprints deterministically", () => {
    expect(STORY_FIXTURES.explainer.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("fixtures", () => {
  it.each(Object.entries(STORY_FIXTURES))("%s passes the lints", (_name, spec) => {
    expect(lintEpisode(spec)).toEqual([]);
  });
  it("covers the five required shapes", () => {
    expect(Object.keys(STORY_FIXTURES).sort()).toEqual([
      "explainer",
      "recurring",
      "singleProtagonist",
      "threeCharacter",
      "twoCharacterDialogue",
    ]);
  });
});

describe("lintEpisode rejections", () => {
  const base = STORY_FIXTURES.singleProtagonist;
  const withBeats = (f: (b: EpisodeSpec["beats"]) => EpisodeSpec["beats"]): EpisodeSpec => ({
    ...base,
    beats: f(base.beats),
  });
  it("rejects a beat without want, conflict or outcome", () => {
    const spec = withBeats((b) => b.map((x, i) => (i === 2 ? { ...x, conflict: " " } : x)));
    expect(lintEpisode(spec)).toContain(`beat_incomplete:${base.beats[2]?.id}`);
  });
  it("rejects a first beat that is not a hook", () => {
    const spec = withBeats((b) =>
      b.map((x, i) => (i === 0 ? { ...x, kind: "setup" as const } : x)),
    );
    expect(lintEpisode(spec)).toContain("first_beat_not_hook");
  });
  it("rejects and-then chains (missing link or and-then wording)", () => {
    const missing = withBeats((b) =>
      b.map((x, i) => {
        if (i !== 3) return x;
        const { link: _link, ...rest } = x;
        return rest;
      }),
    );
    expect(lintEpisode(missing)).toContain(`beat_missing_link:${base.beats[3]?.id}`);
    const worded = withBeats((b) =>
      b.map((x, i) => (i === 3 ? { ...x, outcome: "And then she goes home" } : x)),
    );
    expect(lintEpisode(worded)).toContain(`beat_and_then:${base.beats[3]?.id}`);
  });
  it("rejects a hook longer than 9 words", () => {
    expect(
      lintEpisode({ ...base, hook: "one two three four five six seven eight nine ten" }),
    ).toContain("hook_too_long");
  });
  it("rejects an unpaid plant in a short episode but carries it in a mid one", () => {
    const planted = { ...base, plants: [{ id: "p1", beatId: base.beats[1]?.id ?? "" }], pays: [] };
    expect(lintEpisode(planted)).toContain("plant_unpaid:p1");
    const mid = { ...planted, idea: { ...base.idea, durationClass: "mid" as const } };
    expect(lintEpisode(mid)).toEqual([]);
  });
  it("rejects a pay that lands before its plant and dangling refs", () => {
    const b = base.beats;
    const early = {
      ...base,
      plants: [{ id: "p1", beatId: b[4]?.id ?? "" }],
      pays: [{ plantId: "p1", beatId: b[1]?.id ?? "" }],
    };
    expect(lintEpisode(early)).toContain("pay_before_plant:p1");
    const dangling = { ...base, plants: [{ id: "p2", beatId: "nope" }] };
    expect(lintEpisode(dangling)).toContain("plant_beat_unknown:p2");
  });
});

describe("lintSeriesPlants", () => {
  const mid = (
    id: string,
    plants: EpisodeSpec["plants"],
    pays: EpisodeSpec["pays"],
  ): EpisodeSpec => ({
    ...STORY_FIXTURES.recurring,
    id,
    idea: { ...STORY_FIXTURES.recurring.idea, durationClass: "mid" },
    plants,
    pays,
  });
  const beat = STORY_FIXTURES.recurring.beats[1]?.id ?? "";
  it("flags a plant unpaid after 3 more episodes, not before", () => {
    const eps = [mid("e1", [{ id: "p", beatId: beat }], []), mid("e2", [], []), mid("e3", [], [])];
    expect(lintSeriesPlants(eps)).toEqual([]);
    expect(lintSeriesPlants([...eps, mid("e4", [], [])])).toEqual([]);
    expect(lintSeriesPlants([...eps, mid("e4", [], []), mid("e5", [], [])])).toEqual([
      "plant_overdue:p",
    ]);
  });
  it("accepts a plant paid in a later episode", () => {
    const eps = [
      mid("e1", [{ id: "p", beatId: beat }], []),
      mid("e2", [], [{ plantId: "p", beatId: beat }]),
      mid("e3", [], []),
      mid("e4", [], []),
      mid("e5", [], []),
    ];
    expect(lintSeriesPlants(eps)).toEqual([]);
  });
});
