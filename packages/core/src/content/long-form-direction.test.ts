import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { LONG_FORM_MAX_SCENES } from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import {
  type SceneDirector,
  type SceneDirectorInput,
  STICK_V1_CATALOG,
} from "../explainer/scene-director.js";
import type { SceneSpec } from "../explainer/scene-spec.js";
import { directorPlanFrom, scriptSegments } from "./director-plan.js";
import { createContentScript, type ScriptBeat } from "./editorial.js";
import {
  aggregateChapterScenes,
  CHAPTER_MAX_SEGMENTS,
  chapterInput,
  checkLongFormOutput,
  directLongForm,
  MAX_CHAPTERS,
  pacingBlocked,
  pacingReport,
  splitChapters,
} from "./long-form-direction.js";
import { createStoryboard } from "./storyboard.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const TOPICS = ["rent", "power", "water", "food", "fuel", "phone", "fees", "tax"];
/** ~15 words per sentence, unique per index so copy checks stay meaningful. */
const sentence = (n: number): string =>
  `Item ${TOPICS[n % TOPICS.length]} number ${n} shows what the bill really includes when nobody reads the small print.`;
const bodyOf = (sentenceCount: number, paragraphEvery = 0): string =>
  Array.from({ length: sentenceCount }, (_, n) => {
    const end = paragraphEvery && (n + 1) % paragraphEvery === 0 && n + 1 < sentenceCount;
    return sentence(n + 1) + (end ? "\n\n" : " ");
  })
    .join("")
    .trim();

const inputFor = (body: string, beats: readonly ScriptBeat[] = []): SceneDirectorInput => {
  const draft = createContentScript({
    workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
    contentItemId: "item-1",
    version: 1,
    body,
    language: "en-US",
    claims: [],
    beats,
    actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
  });
  return {
    script: { ...draft, status: "approved" },
    persona: [alex],
    catalog: STICK_V1_CATALOG,
    timing: [],
  };
};

const chapterBeats = (body: string, every: number): ScriptBeat[] =>
  scriptSegments(body)
    .filter((_, i) => i > 0 && i % every === 0)
    .map((s) => ({ kind: "chapter" as const, atChar: s.fromChar, label: `c${s.fromChar}` }));

const BACKGROUNDS = STICK_V1_CATALOG.backgrounds;
const CAMERAS = [
  { shot: "medium", movement: "none" },
  { shot: "close", movement: "push_in" },
  { shot: "wide", movement: "slow_zoom_out" },
] as const;
const PURPOSES = ["explanation", "question", "escalation", "explanation", "surprise"] as const;

/** A director that cuts every two segments, hook first and payoff last. */
const fakeScenes = (chapterBody: string): SceneSpec[] => {
  const segments = scriptSegments(chapterBody);
  const cuts = segments.map((s) => s.fromChar).filter((_, i) => i % 2 === 0);
  const count = Math.min(cuts.length, 12);
  const scenes = cuts.slice(0, count).map(
    (from, i): SceneSpec => ({
      index: i + 1,
      fromChar: from,
      toChar: cuts[i + 1] ?? chapterBody.length,
      purpose:
        i === 0
          ? "hook"
          : i === count - 1
            ? "payoff"
            : (PURPOSES[i % PURPOSES.length] ?? "explanation"),
      background: BACKGROUNDS[i % BACKGROUNDS.length] ?? "kitchen",
      actors: [
        { characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" },
      ],
      props: [],
      overlays: [],
      camera: CAMERAS[i % CAMERAS.length] as SceneSpec["camera"],
      transition: "hard_cut",
      captionMode: "word",
    }),
  );
  const last = scenes.at(-1);
  if (last) scenes[scenes.length - 1] = { ...last, toChar: chapterBody.length };
  return scenes;
};
const countingDirector = (): SceneDirector & { calls: number } => ({
  calls: 0,
  async direct(input) {
    this.calls += 1;
    return directorPlanFrom(fakeScenes(input.script.body), input.script.body);
  },
});

describe("splitChapters", () => {
  it("uses chapter beats, starts at 0, is contiguous and covers the body", () => {
    const body = bodyOf(60);
    const beats = chapterBeats(body, 15);
    const chapters = splitChapters(body, beats);
    expect(chapters).toHaveLength(4);
    expect(chapters[0]?.fromChar).toBe(0);
    for (const [i, c] of chapters.entries()) {
      expect(c.index).toBe(i + 1);
      expect(c.fromChar).toBe(i === 0 ? 0 : chapters[i - 1]?.toChar);
    }
    expect(chapters.at(-1)?.toChar).toBe(body.length);
    expect(chapters[1]?.fromChar).toBe(beats[0]?.atChar);
  });

  it("snaps a mid-sentence beat to its sentence and ignores beats at 0", () => {
    const body = bodyOf(30);
    const segments = scriptSegments(body);
    const mid = (segments[15]?.fromChar ?? 0) + 5;
    const chapters = splitChapters(body, [
      { kind: "chapter", atChar: 0 },
      { kind: "chapter", atChar: mid },
    ]);
    expect(chapters.map((c) => c.fromChar)).toEqual([0, segments[15]?.fromChar]);
  });

  it("falls back to paragraphs, then to equal size parts within the bound", () => {
    expect(splitChapters(bodyOf(48, 12), [])).toHaveLength(4);
    const body = bodyOf(100);
    const sized = splitChapters(body, []);
    expect(sized.length).toBe(Math.ceil(100 / CHAPTER_MAX_SEGMENTS));
    for (const c of sized) {
      const n = scriptSegments(body.slice(c.fromChar, c.toChar)).length;
      expect(n).toBeLessThanOrEqual(CHAPTER_MAX_SEGMENTS);
      expect(n).toBeGreaterThanOrEqual(3);
    }
  });

  it("merges tiny chapters and splits oversized ones", () => {
    const body = bodyOf(50);
    const segments = scriptSegments(body);
    const chapters = splitChapters(body, [
      { kind: "chapter", atChar: segments[1]?.fromChar ?? 1 },
      { kind: "chapter", atChar: segments[40]?.fromChar ?? 1 },
    ]);
    expect(chapters[0]?.fromChar).toBe(0);
    expect(chapters.at(-1)?.toChar).toBe(body.length);
    for (const c of chapters) {
      const n = scriptSegments(body.slice(c.fromChar, c.toChar)).length;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(CHAPTER_MAX_SEGMENTS);
    }
  });

  it("rebases beats into the chapter and leaves claims alone", () => {
    const body = bodyOf(36);
    const beats = chapterBeats(body, 18);
    const input = inputFor(body, [...beats, { kind: "payoff", atChar: body.length - 5 }]);
    const second = splitChapters(body, beats)[1];
    if (!second) throw new Error("chapter missing");
    const part = chapterInput(input, second);
    expect(part.script.body).toBe(body.slice(second.fromChar, second.toChar));
    expect(part.script.beats.map((b) => b.atChar)).toEqual([0, part.script.body.length - 5]);
    expect(part.script.claims).toBe(input.script.claims);
  });
});

describe("long-form direction, end to end with a fake director", () => {
  const body = bodyOf(100);
  const beats = chapterBeats(body, 17);
  const input = inputFor(body, beats);

  it("directs each chapter once and aggregates a valid long storyboard", async () => {
    expect(body.split(/\s+/).length).toBeGreaterThan(1400);
    const director = countingDirector();
    const result = await directLongForm(director, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chapters = splitChapters(body, beats);
    expect(director.calls).toBe(chapters.length);
    const { scenes } = result;
    expect(scenes.length).toBeGreaterThan(12);
    expect(scenes.map((s) => s.index)).toEqual(scenes.map((_, i) => i + 1));
    expect(scenes[0]?.fromChar).toBe(0);
    expect(scenes.at(-1)?.toChar).toBe(body.length);
    for (const [i, s] of scenes.entries())
      if (i > 0) expect(s.fromChar).toBe(scenes[i - 1]?.toChar);
    expect(scenes.map((s) => body.slice(s.fromChar, s.toChar)).join("")).toBe(body);
    expect(scenes[0]?.purpose).toBe("hook");
    expect(scenes.slice(1).filter((s) => s.purpose === "hook")).toHaveLength(0);
    for (const c of chapters.slice(1))
      expect(scenes.find((s) => s.fromChar === c.fromChar)?.purpose).toBe("setup");
    for (let i = 1; i < scenes.length; i += 1)
      expect(`${scenes[i]?.camera.shot}:${scenes[i]?.camera.movement}`).not.toBe(
        `${scenes[i - 1]?.camera.shot}:${scenes[i - 1]?.camera.movement}`,
      );
    expect(pacingBlocked(pacingReport({ scenes, body, language: "en-US", chapters }))).toBe(false);
  });

  it("the result gate takes one raw plan per chapter and rejects a wrong count", () => {
    const chapters = splitChapters(body, beats);
    const raw = chapters.map((c) => {
      const part = body.slice(c.fromChar, c.toChar);
      return directorPlanFrom(fakeScenes(part), part);
    });
    expect(checkLongFormOutput(raw, input).ok).toBe(true);
    expect(checkLongFormOutput(raw.slice(1), input).ok).toBe(false);
    expect(checkLongFormOutput(raw[0], input).ok).toBe(false);
  });

  it("the result gate rejects more than MAX_CHAPTERS chapters", () => {
    const wideBody = bodyOf(10 * (MAX_CHAPTERS + 1));
    const wideInput = inputFor(wideBody, chapterBeats(wideBody, 10));
    const checked = checkLongFormOutput([], wideInput);
    expect(checked.ok).toBe(false);
    if (!checked.ok)
      expect(checked.failure.issues.map((i) => i.code)).toContain("chapter_count_exceeded");
  });

  it("fails the whole script when a chapter fails", async () => {
    let n = 0;
    const flaky: SceneDirector = {
      async direct(i) {
        n += 1;
        return n >= 3 ? "not json" : directorPlanFrom(fakeScenes(i.script.body), i.script.body);
      },
    };
    expect((await directLongForm(flaky, input)).ok).toBe(false);
  });

  it("keeps global copy integrity: overlay text must come from the full body", () => {
    const chapters = splitChapters(body, beats);
    const perChapter = chapters.map((c) => fakeScenes(body.slice(c.fromChar, c.toChar)));
    const bad = perChapter.map((scenes, i) =>
      i === 1
        ? scenes.map((s, j) =>
            j === 0
              ? { ...s, overlays: [{ text: "invented words", position: "top" as const }] }
              : s,
          )
        : scenes,
    );
    const checked = aggregateChapterScenes(input, chapters, bad);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.failure.reason).toBe("guard_rejected");
  });

  describe("global overlay strip", () => {
    const bigBody = bodyOf(100);
    const bigBeats = chapterBeats(bigBody, 10);
    const bigInput = inputFor(bigBody, bigBeats);
    const chapters = splitChapters(bigBody, bigBeats);
    const withOverlays = (pointed: (chapter: number, scene: number) => boolean) =>
      chapters.map((c, ci) =>
        fakeScenes(bigBody.slice(c.fromChar, c.toChar)).map((scene, j) => {
          const text = bigBody
            .slice(c.fromChar + scene.fromChar, c.fromChar + scene.toChar)
            .split(/\s+/)
            .slice(0, 3)
            .join(" ");
          return {
            ...scene,
            overlays: [{ text, position: "top" as const }],
            actors: pointed(ci, j)
              ? scene.actors.map((a) => ({
                  ...a,
                  actions: [
                    {
                      type: "point_at" as const,
                      atWord: 0,
                      target: { kind: "overlay" as const, index: 0 },
                    },
                  ],
                }))
              : scene.actors,
          };
        }),
      );

    it("never strips an overlay that a point_at targets", () => {
      expect(chapters).toHaveLength(10);
      const checked = aggregateChapterScenes(
        bigInput,
        chapters,
        withOverlays((ci, j) => ci === 9 && j === 3),
      );
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      const pointed = checked.scenes.filter((s) => s.actors.some((a) => a.actions?.length));
      expect(pointed).toHaveLength(1);
      expect(pointed[0]?.overlays).toHaveLength(1);
    });

    it("drops targeting actions with the overlay when the quota cannot be met otherwise", () => {
      const checked = aggregateChapterScenes(
        bigInput,
        chapters,
        withOverlays(() => true),
      );
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.scenes.filter((s) => s.overlays.length)).toHaveLength(15);
    });
  });

  it("uses the plain single call when the script fits one chapter", async () => {
    const director = countingDirector();
    expect((await directLongForm(director, inputFor(bodyOf(12)))).ok).toBe(true);
    expect(director.calls).toBe(1);
  });
});

describe("long-form cap", () => {
  const input = inputFor(bodyOf(60));
  const wide = (count: number): SceneSpec[] =>
    Array.from({ length: count }, (_, i) => ({
      ...(fakeScenes(input.script.body)[0] as SceneSpec),
      index: i + 1,
      fromChar: i,
      toChar: i + 1,
    }));
  const board = (scenes: SceneSpec[], longForm: boolean) =>
    createStoryboard({
      workspaceId: input.script.workspaceId,
      script: { ...input.script, body: "x".repeat(scenes.length) },
      version: 1,
      renderer: "stickman_motion",
      scenes,
      assets: [],
      characters: [alex],
      voiceId: "v",
      canvas: "portrait",
      actorId: input.script.actorId,
      longForm,
    });

  it("keeps short-form at 12 and rejects long-form above the cap", () => {
    expect(() => board(wide(13), false)).toThrow("storyboard_invalid");
    expect(() => board(wide(LONG_FORM_MAX_SCENES + 1), true)).toThrow("storyboard_invalid");
  });

  it("pacing blocks scene counts over the cap", () => {
    const findings = pacingReport({
      scenes: wide(LONG_FORM_MAX_SCENES + 1),
      body: "x".repeat(200),
      language: "en-US",
    });
    expect(findings.some((f) => f.code === "scene_cap_exceeded" && f.severity === "block")).toBe(
      true,
    );
  });
});

describe("pacingReport", () => {
  const base = inputFor(bodyOf(12));
  const text = base.script.body;
  const scenes = fakeScenes(text);

  it("is clean for a well paced storyboard", () => {
    expect(pacingBlocked(pacingReport({ scenes, body: text, language: "en-US" }))).toBe(false);
  });

  it("blocks only objective coverage errors", () => {
    const gap = scenes.map((s, i) => (i === 1 ? { ...s, fromChar: s.fromChar + 3 } : s));
    const blocked = pacingReport({ scenes: gap, body: text, language: "en-US" });
    expect(blocked.filter((f) => f.severity === "block").map((f) => f.code)).toContain(
      "coverage_invalid",
    );
    expect(
      pacingBlocked(pacingReport({ scenes: scenes.slice(0, -1), body: text, language: "en-US" })),
    ).toBe(true);
  });

  it("warns, never blocks, on slow or repetitive direction", () => {
    const first = scenes[0] as SceneSpec;
    const one = pacingReport({
      scenes: [{ ...first, index: 1, fromChar: 0, toChar: text.length }],
      body: text,
      language: "en-US",
    });
    expect(pacingBlocked(one)).toBe(false);
    expect(one.map((f) => f.code)).toEqual(
      expect.arrayContaining(["scene_too_wordy", "slow_average_pace"]),
    );
    const same = scenes.map((s) => ({
      ...s,
      purpose: "explanation" as const,
      camera: { shot: "medium", movement: "none" } as SceneSpec["camera"],
      background: first.background,
    }));
    const repeated = pacingReport({ scenes: same, body: text, language: "en-US" });
    expect(pacingBlocked(repeated)).toBe(false);
    expect(repeated.map((f) => f.code)).toEqual(
      expect.arrayContaining(["repeated_shot", "explanation_heavy", "repeated_visual_signature"]),
    );
  });
});
