import { describe, expect, it } from "vitest";
import {
  NOVELTY_TUNABLES,
  type EpisodeRecord,
  hookForm,
  noveltyFingerprint,
  noveltySignals,
  seriesNovelty,
} from "./novelty-guard.js";
import { STORY_FIXTURES, fixtureIdea } from "./fixtures.js";
import { buildEpisodePlan, type BeatTemplateId } from "./story.js";

const TEMPLATES: readonly BeatTemplateId[] = [
  "problem_solution",
  "mistake_consequence",
  "secret_reveal",
  "misunderstanding",
  "escalation",
  "discovery",
  "competition",
  "transformation",
  "cause_effect",
];
const rec = (
  id: string,
  idea: Parameters<typeof fixtureIdea>[0] = {},
  hook = "Why is the milk always at the back?",
  extra: Partial<EpisodeRecord> = {},
): EpisodeRecord => ({
  spec: buildEpisodePlan({
    id,
    seriesId: "s",
    idea: fixtureIdea({ id, ...idea }),
    hook,
    targetSec: 60,
    targetAudience: "general",
    contentIntent: "story",
  }),
  ...extra,
});
const codes = (current: EpisodeRecord, recent: readonly EpisodeRecord[]) =>
  noveltySignals(current, recent).map((s) => s.code);

describe("fingerprint", () => {
  it("captures template, cast, places, hook and ending form", () => {
    const fp = noveltyFingerprint(STORY_FIXTURES.threeCharacter);
    expect(fp).toMatchObject({
      template: "competition",
      cast: ["bia", "carla", "rafa"],
      places: ["park/-"],
      hookForm: "statement",
      endingForm: "resolution",
    });
  });
  it.each([
    ["Why now?", "question"],
    ["3 things you miss", "number"],
    ["“Never again”, she said", "quote"],
    ["Nobody checks the back shelf", "statement"],
  ])("classifies the hook %s as %s", (hook, form) => expect(hookForm(hook)).toBe(form));
});

describe("noveltySignals", () => {
  const base = rec("e0", { template: "problem_solution", locationId: "a", castIds: ["x", "y"] });
  const fresh = (
    over: Parameters<typeof fixtureIdea>[0] = {},
    hook = "Nobody checks the back shelf",
  ) => rec("e1", { template: "discovery", locationId: "b", castIds: ["p", "q"], ...over }, hook);

  it("is silent for a clearly different episode", () => {
    expect(codes(fresh(), [base])).toEqual([]);
  });
  it("flags a template reused within 3 episodes but not at 4", () => {
    const same = fresh({ template: "problem_solution" });
    expect(codes(same, [base])).toContain("template_cooldown");
    const filler = (i: number) =>
      rec(`f${i}`, {
        template: TEMPLATES[i + 2] as BeatTemplateId,
        locationId: `l${i}`,
        castIds: [`c${i}`, `d${i}`],
      });
    expect(codes(same, [base, filler(1), filler(2), filler(3)])).not.toContain("template_cooldown");
  });
  it("flags the same focal duo in consecutive episodes", () => {
    expect(codes(fresh({ castIds: ["y", "x"] }), [base])).toContain("focal_duo_consecutive");
    expect(codes(fresh({ castIds: ["x", "z"] }), [base])).not.toContain("focal_duo_consecutive");
  });
  it("logs a place seen in the last 5 episodes", () => {
    const signals = noveltySignals(fresh({ locationId: "a" }), [base]);
    expect(signals.find((s) => s.code === "place_cooldown")?.severity).toBe("LOG");
  });
  it("flags a hook form repeated within 2 episodes", () => {
    expect(codes(fresh(), [rec("e0", { locationId: "a" }, "Nobody looks at the front")])).toContain(
      "hook_form_cooldown",
    );
    expect(codes(fresh(), [base])).not.toContain("hook_form_cooldown");
  });
  it("flags an ending form repeated within 3 episodes", () => {
    const prior = rec("e0", { template: "problem_solution", locationId: "a", castIds: ["x", "y"] });
    // problem_solution ends on a button; transformation also ends on a button
    expect(codes(fresh({ template: "transformation" }), [prior])).toContain("ending_form_cooldown");
  });
  it("flags a beat sequence within edit distance 2 of a recent one", () => {
    expect(codes(fresh({ template: "problem_solution", castIds: ["p", "q"] }), [base])).toContain(
      "beat_sequence_similar",
    );
    expect(codes(fresh({ template: "discovery" }), [base])).not.toContain("beat_sequence_similar");
  });
  it("flags 5-gram script overlap above 20%", () => {
    const a =
      "the milk sits at the back of the store so you walk past every shelf before you reach it";
    const b = "the milk sits at the back of the store so you walk past every shelf and then pay";
    expect(codes(fresh({}, "Different hook here"), [{ ...base, scriptBody: a }])).not.toContain(
      "script_overlap",
    );
    expect(codes({ ...fresh(), scriptBody: b }, [{ ...base, scriptBody: a }])).toContain(
      "script_overlap",
    );
    expect(
      codes(
        {
          ...fresh(),
          scriptBody: "completely unrelated words about something else entirely today",
        },
        [{ ...base, scriptBody: a }],
      ),
    ).not.toContain("script_overlap");
  });
  it("flags dialogue 4-gram Jaccard above 0.15", () => {
    const withLines = (text: string): EpisodeRecord => {
      const r = rec("d", { locationId: "a", castIds: ["x", "y"] });
      return {
        spec: {
          ...r.spec,
          beats: r.spec.beats.map((b, i) =>
            i === 1 ? { ...b, dialogue: [{ characterId: "x", text }] } : b,
          ),
        },
      };
    };
    const line = "we keep the key behind the register where nobody looks";
    expect(codes({ ...fresh(), spec: withLines(line).spec }, [withLines(line)])).toContain(
      "dialogue_overlap",
    );
    expect(
      codes(
        {
          ...fresh(),
          spec: withLines("a fresh and unrelated conversation about the weather").spec,
        },
        [withLines(line)],
      ),
    ).not.toContain("dialogue_overlap");
  });
  it("flags a camera pattern identical to the previous 3 only", () => {
    const cam = ["medium:none", "wide:pan"];
    const prior = (i: number) => ({
      ...rec(`c${i}`, {
        locationId: `l${i}`,
        castIds: [`a${i}`, `b${i}`],
        template: TEMPLATES[i] as BeatTemplateId,
      }),
      cameraPattern: cam,
    });
    const now = { ...fresh(), cameraPattern: cam };
    expect(codes(now, [prior(0), prior(1), prior(2)])).toContain("camera_pattern_repeat");
    expect(codes(now, [prior(1), prior(2)])).not.toContain("camera_pattern_repeat");
    expect(
      codes({ ...now, cameraPattern: ["close:none"] }, [prior(0), prior(1), prior(2)]),
    ).not.toContain("camera_pattern_repeat");
  });
  it("flags fixed brand time above 15% and an empty sourced-fact slot", () => {
    expect(codes({ ...fresh(), brandSec: 9.5 }, [])).toContain("brand_time_share");
    expect(codes({ ...fresh(), brandSec: 9 }, [])).not.toContain("brand_time_share");
    const explainer: EpisodeRecord = { spec: STORY_FIXTURES.explainer, sourcedFactCount: 0 };
    expect(codes(explainer, [])).toContain("empty_sourced_fact_slot");
    expect(codes({ ...explainer, sourcedFactCount: 2 }, [])).not.toContain(
      "empty_sourced_fact_slot",
    );
    expect(codes({ spec: STORY_FIXTURES.explainer }, [])).not.toContain("empty_sourced_fact_slot");
  });
});

describe("never blocks", () => {
  it("emits only LOG or WARN for every tunable and every signal", () => {
    for (const t of Object.values(NOVELTY_TUNABLES)) expect(["LOG", "WARN"]).toContain(t.severity);
    const all: EpisodeRecord[] = Object.values(STORY_FIXTURES).map((spec) => ({
      spec,
      scriptBody: "same words repeated across every single episode of this series today",
      cameraPattern: ["medium:none"],
      brandSec: 30,
      sourcedFactCount: 0,
    }));
    const signals = all.flatMap((r) => noveltySignals(r, all));
    expect(signals.length).toBeGreaterThan(5);
    expect(signals.every((s) => s.severity === "LOG" || s.severity === "WARN")).toBe(true);
  });
});

describe("seriesNovelty", () => {
  it("reports signals for the last 10 episodes of a longer series", () => {
    const episodes = Array.from({ length: 12 }, (_, i) =>
      rec(
        `s${i}`,
        { template: "problem_solution", locationId: "shop", castIds: ["carla", "bia"] },
        "Why is it so?",
      ),
    );
    const report = seriesNovelty(episodes);
    expect(report).toHaveLength(10);
    expect(report[0]?.episodeId).toBe("s2");
    expect(report.at(-1)?.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(["template_cooldown", "focal_duo_consecutive", "hook_form_cooldown"]),
    );
  });
  it("gives the first episode of a series no signals", () => {
    expect(seriesNovelty([rec("only")])[0]?.signals).toEqual([]);
  });
});
