import { LONG_FORM_MAX_SCENES } from "@money-maker/contracts/scene-spec-schema";
import type { SceneDirector, SceneDirectorInput } from "../explainer/scene-director.js";
import {
  type ActorAction,
  collectSceneSpecIssues,
  MAX_OVERLAY_SHARE,
  type SceneSpec,
  sceneSignature,
  sceneSpecWarnings,
  sceneWordCount,
} from "../explainer/scene-spec.js";
import { narrationMsPerWord } from "../explainer/script-guards.js";
import {
  checkDirectorOutput,
  copyIntegrityCheck,
  type DirectAttempt,
  type DirectorCheck,
  type DirectorIssue,
  type DirectScenesResult,
  directScenes,
} from "./direct-scenes.js";
import {
  normalizeCameraSequence,
  normalizeVisualSignatures,
  scriptSegments,
} from "./director-plan.js";
import { createStoryboard } from "./storyboard.js";

/**
 * Long-form scene direction (cost-curious plan C.2, phase 5). The frozen Scene Director keeps its
 * per-call contract (3 to 12 scenes); a long script is cut into chapters, each directed as its own
 * script, and the results are stitched into one storyboard. Nothing here touches the director.
 */

/** The director's own per-call scene ceiling (directorSceneBoundaries). */
const DIRECTOR_MAX_SCENES = 12;
/** The director's own minimum segment count for a call (3 scenes). */
const DIRECTOR_MIN_SEGMENTS = 3;
/**
 * A chapter holds at most 1.5 sentence segments per scene the director may cut (18), so a full
 * chapter still averages two thirds of a sentence per scene and stays well inside its input size.
 */
export const CHAPTER_MAX_SEGMENTS = Math.floor(DIRECTOR_MAX_SCENES * 1.5);
/** Enough chapters of up to 12 scenes to reach the aggregate cap. */
export const MAX_CHAPTERS = Math.ceil(LONG_FORM_MAX_SCENES / DIRECTOR_MAX_SCENES);

export type Chapter = Readonly<{ index: number; fromChar: number; toChar: number }>;

type Cut = readonly number[];

/** Segment indexes (ascending, first is 0) where a chapter starts. */
const startIndexes = (body: string, beats: SceneDirectorInput["script"]["beats"]): Cut => {
  const segments = scriptSegments(body);
  const atBeats = new Set<number>();
  for (const beat of beats)
    if (beat.kind === "chapter" && beat.atChar > 0) {
      const at = segments.findIndex((s) => s.fromChar <= beat.atChar && beat.atChar < s.toChar);
      if (at > 0) atBeats.add(at);
    }
  if (atBeats.size > 0) return [0, ...[...atBeats].sort((a, b) => a - b)];
  // No chapter beats: a paragraph break (a blank line closing the previous segment) starts one.
  return [
    0,
    ...segments.flatMap((_, i) =>
      i > 0 && /\n\s*\n$/.test(segments[i - 1]?.text ?? "") ? [i] : [],
    ),
  ];
};

/**
 * Deterministic chapters: `chapter` beats (snapped to the sentence they fall in) when present,
 * else paragraphs. Groups under 3 segments merge into the previous one (the first into the next);
 * groups over CHAPTER_MAX_SEGMENTS split into equal parts. First starts at 0, contiguous, exact.
 */
export const splitChapters = (
  body: string,
  beats: SceneDirectorInput["script"]["beats"],
): readonly Chapter[] => {
  const segments = scriptSegments(body);
  const starts = startIndexes(body, beats);
  let groups = starts.map((start, i) => ({ start, end: starts[i + 1] ?? segments.length }));
  for (let i = 0; i < groups.length; ) {
    const group = groups[i];
    if (group && group.end - group.start < DIRECTOR_MIN_SEGMENTS && groups.length > 1) {
      const into = i > 0 ? i - 1 : 1;
      const other = groups[into];
      if (other)
        groups.splice(Math.min(i, into), 2, {
          start: Math.min(group.start, other.start),
          end: Math.max(group.end, other.end),
        });
      i = Math.max(0, Math.min(i, into));
    } else i += 1;
  }
  groups = groups.flatMap(({ start, end }) => {
    const parts = Math.ceil((end - start) / CHAPTER_MAX_SEGMENTS);
    return Array.from({ length: parts }, (_, p) => ({
      start: start + Math.floor(((end - start) * p) / parts),
      end: start + Math.floor(((end - start) * (p + 1)) / parts),
    }));
  });
  return groups.map(({ start, end }, i) => ({
    index: i + 1,
    fromChar: i === 0 ? 0 : (segments[start]?.fromChar ?? 0),
    toChar: segments[end - 1]?.toChar ?? body.length,
  }));
};

/** The chapter as its own director input: body slice, rebased beats; claims and cast untouched. */
export const chapterInput = (input: SceneDirectorInput, chapter: Chapter): SceneDirectorInput => ({
  ...input,
  script: {
    ...input.script,
    body: input.script.body.slice(chapter.fromChar, chapter.toChar),
    beats: input.script.beats
      .filter((beat) => beat.atChar >= chapter.fromChar && beat.atChar < chapter.toChar)
      .map((beat) => ({ ...beat, atChar: beat.atChar - chapter.fromChar })),
  },
  // ponytail: word timing is empty in every director path today; slice it when narration precedes direction.
  timing: [],
});

const issueOf = (
  code: string,
  message: string,
  extra: Partial<DirectorIssue> = {},
): DirectorIssue => ({
  code,
  message,
  ...extra,
});
const failure = (
  reason: DirectAttempt["reason"],
  issues: readonly DirectorIssue[],
): Extract<DirectorCheck, { ok: false }> => ({
  ok: false,
  failure: {
    reason,
    errors: issues.slice(0, 20).map((i) => `[${i.code}]: ${i.message}`),
    issues: issues.slice(0, 20),
  },
});

const isOverlayAction = (action: ActorAction): boolean =>
  "target" in action && action.target.kind === "overlay";

const OVERLAY_PRIORITY = (purpose: SceneSpec["purpose"]): number =>
  purpose === "hook" ? 0 : purpose === "payoff" ? 1 : purpose === "cta" ? 2 : 3;

/**
 * Stitches validated chapter scenes into one storyboard: global indices and offsets, only scene 1
 * stays `hook` (a later chapter's opener becomes `setup`, which the purpose list already has),
 * camera and visual-signature normalization across seams, the global overlay share, then the one
 * storyboard gate (coverage, long-form cap, scene rules) and global copy integrity.
 */
export const aggregateChapterScenes = (
  input: SceneDirectorInput,
  chapters: readonly Chapter[],
  perChapter: readonly (readonly SceneSpec[])[],
): DirectorCheck => {
  const joined = perChapter.flatMap((scenes, c) => {
    const offset = chapters[c]?.fromChar ?? 0;
    return scenes.map((scene, j) => ({
      ...scene,
      fromChar: scene.fromChar + offset,
      toChar: scene.toChar + offset,
      purpose: c > 0 && j === 0 && scene.purpose === "hook" ? ("setup" as const) : scene.purpose,
    }));
  });
  const indexed = joined.map((scene, i) => ({ ...scene, index: i + 1 }));
  const normalized = normalizeVisualSignatures(
    normalizeCameraSequence(indexed, input.catalog, input.locations ?? []),
    input.catalog,
  );
  const quota = Math.ceil(normalized.length * MAX_OVERLAY_SHARE);
  // A point_at/look_at aimed at an overlay needs that overlay: such scenes are stripped last, and
  // when they alone exceed the quota their overlay-targeted actions go with the overlay.
  const targetsOverlay = (scene: SceneSpec): boolean =>
    scene.actors.some((actor) => (actor.actions ?? []).some(isOverlayAction));
  const keep = new Set(
    normalized
      .flatMap((scene, i) =>
        scene.overlays.length
          ? [{ i, p: OVERLAY_PRIORITY(scene.purpose), t: targetsOverlay(scene) }]
          : [],
      )
      .sort((a, b) => Number(b.t) - Number(a.t) || a.p - b.p || a.i - b.i)
      .slice(0, quota)
      .map(({ i }) => i),
  );
  const scenes = normalized.map((scene, i) =>
    keep.has(i)
      ? scene
      : {
          ...scene,
          overlays: [],
          actors: scene.actors.map((actor) =>
            actor.actions?.some(isOverlayAction)
              ? { ...actor, actions: actor.actions.filter((a) => !isOverlayAction(a)) }
              : actor,
          ),
        },
  );
  const { body } = input.script;
  try {
    createStoryboard({
      workspaceId: input.script.workspaceId,
      script: input.script,
      version: 1,
      renderer: "stickman_motion",
      scenes,
      assets: [],
      characters: input.persona,
      voiceId: "director_check",
      canvas: "portrait",
      actorId: input.script.actorId,
      longForm: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "storyboard_invalid";
    const sceneIssues = message.startsWith("storyboard_scene_invalid:")
      ? collectSceneSpecIssues({
          scenes,
          characters: input.persona,
          claims: input.script.claims,
          renderer: "stickman_motion",
          language: input.script.language,
          sceneTexts: scenes.map((scene) => body.slice(scene.fromChar, scene.toChar)),
        })
      : [];
    return failure(
      "scene_rejected",
      sceneIssues.length > 0
        ? sceneIssues
        : [issueOf(message.split(":")[0] ?? "storyboard_invalid", message)],
    );
  }
  const copy = copyIntegrityCheck(
    scenes,
    body,
    input.catalog.props.map((prop) => prop.replaceAll("_", " ")),
  );
  if (copy.length > 0)
    return failure(
      "guard_rejected",
      copy.map((problem) => issueOf(problem.split(":")[0] ?? problem, problem)),
    );
  return { ok: true, scenes };
};

const prefixed = (check: Extract<DirectorCheck, { ok: false }>, chapter: Chapter) =>
  failure(
    check.failure.reason,
    check.failure.issues.map((i) => ({ ...i, message: `chapter ${chapter.index}: ${i.message}` })),
  );

/** The one chapter-count rule, shared by the gate, the server path and the home worker. */
export const chapterCountIssue = (count: number) =>
  count > MAX_CHAPTERS
    ? issueOf("chapter_count_exceeded", `At most ${MAX_CHAPTERS} chapters`, {
        expected: String(MAX_CHAPTERS),
        actual: String(count),
      })
    : undefined;

/** The gate for a long-form result: one raw director output per chapter (ADR 0012 and tests). */
export const checkLongFormOutput = (raw: unknown, input: SceneDirectorInput): DirectorCheck => {
  const chapters = splitChapters(input.script.body, input.script.beats);
  const tooMany = chapterCountIssue(chapters.length);
  if (tooMany) return failure("output_invalid", [tooMany]);
  if (!Array.isArray(raw) || raw.length !== chapters.length)
    return failure("output_invalid", [
      issueOf(
        "chapter_count_mismatch",
        `Return one director output for each of ${chapters.length} chapters`,
      ),
    ]);
  const perChapter: (readonly SceneSpec[])[] = [];
  for (const [i, chapter] of chapters.entries()) {
    const checked = checkDirectorOutput(raw[i], chapterInput(input, chapter));
    if (!checked.ok) return prefixed(checked, chapter);
    perChapter.push(checked.scenes);
  }
  return aggregateChapterScenes(input, chapters, perChapter);
};

/**
 * One directScenes call per chapter (each with its own correction round), then the aggregate.
 * A script that fits one chapter is the plain single call. A failed chapter fails the whole
 * script; nothing is repaired. Retries restart from chapter 1 (chapters are not persisted).
 */
export const directLongForm = async (
  director: SceneDirector,
  input: SceneDirectorInput,
): Promise<DirectScenesResult> => {
  const chapters = splitChapters(input.script.body, input.script.beats);
  if (chapters.length < 2) return directScenes(director, input);
  const issue = chapterCountIssue(chapters.length);
  if (issue) {
    return {
      ok: false,
      reason: "scene_rejected",
      attempts: [{ reason: "scene_rejected", errors: [issue.message], issues: [issue] }],
    };
  }
  const perChapter: (readonly SceneSpec[])[] = [];
  const attempts: DirectAttempt[] = [];
  for (const chapter of chapters) {
    const result = await directScenes(director, chapterInput(input, chapter));
    attempts.push(...result.attempts);
    if (!result.ok) return { ok: false, reason: result.reason, attempts };
    perChapter.push(result.scenes);
  }
  const aggregate = aggregateChapterScenes(input, chapters, perChapter);
  if (!aggregate.ok)
    return {
      ok: false,
      reason: aggregate.failure.reason,
      attempts: [...attempts, aggregate.failure],
    };
  return { ok: true, scenes: aggregate.scenes, attempts };
};

// ------------------------------------------------------------------ pacing gate

export type PacingSeverity = "block" | "warn" | "info";
export type PacingFinding = Readonly<{
  severity: PacingSeverity;
  code: string;
  sceneIndex?: number;
  detail: string;
}>;
/** Heuristic thresholds; tune from retention data, they never block. */
const PACING = Object.freeze({
  maxSceneWords: 45,
  maxSceneSeconds: 15,
  maxAvgSceneSeconds: 12,
  maxSameLayoutRun: 3,
  maxSameShotRun: 4,
  signatureWindow: 4,
  maxExplanationShare: 0.5,
  maxChapterSeconds: 240,
});

const runOf = <T>(values: readonly T[], limit: number): number[] => {
  const hits: number[] = [];
  let run = 0;
  for (const [i, value] of values.entries()) {
    run = i > 0 && value !== undefined && value === values[i - 1] ? run + 1 : 1;
    if (run === limit + 1) hits.push(i);
  }
  return hits;
};

/**
 * Pure pre-render pacing report. Only objective errors block: the scenes do not cover the body
 * exactly, or there are more than LONG_FORM_MAX_SCENES. Everything else is a warn or info.
 */
export const pacingReport = (input: {
  scenes: readonly SceneSpec[];
  body: string;
  language: string;
  chapters?: readonly Chapter[];
}): readonly PacingFinding[] => {
  const { scenes, body } = input;
  const findings: PacingFinding[] = [];
  const add = (severity: PacingSeverity, code: string, detail: string, sceneIndex?: number) =>
    findings.push({ severity, code, detail, ...(sceneIndex === undefined ? {} : { sceneIndex }) });
  if (scenes.length > LONG_FORM_MAX_SCENES)
    add("block", "scene_cap_exceeded", `${scenes.length} scenes, cap ${LONG_FORM_MAX_SCENES}`);
  let cursor = 0;
  for (const [i, scene] of scenes.entries()) {
    if (scene.index !== i + 1 || scene.fromChar !== cursor || scene.toChar <= scene.fromChar)
      add("block", "coverage_invalid", `scene ${i + 1} breaks contiguity at char ${cursor}`, i + 1);
    cursor = scene.toChar;
  }
  if (scenes.length === 0 || cursor !== body.length)
    add("block", "coverage_invalid", `scenes end at ${cursor}, body is ${body.length} chars`);
  const msPerWord = narrationMsPerWord(input.language);
  const texts = scenes.map((scene) => body.slice(scene.fromChar, scene.toChar));
  const words = texts.map(sceneWordCount);
  for (const [i, count] of words.entries()) {
    if (count > PACING.maxSceneWords) add("warn", "scene_too_wordy", `${count} words`, i + 1);
    else if ((count * msPerWord) / 1000 > PACING.maxSceneSeconds)
      add("warn", "scene_too_long", `${Math.round((count * msPerWord) / 1000)} s`, i + 1);
  }
  const total = words.reduce((sum, n) => sum + n, 0);
  const avgSeconds = scenes.length ? (total * msPerWord) / 1000 / scenes.length : 0;
  if (avgSeconds > PACING.maxAvgSceneSeconds)
    add("warn", "slow_average_pace", `${avgSeconds.toFixed(1)} s per scene`);
  for (const warning of sceneSpecWarnings({ scenes, language: input.language, sceneTexts: texts }))
    add(
      "warn",
      warning.split(":")[0] ?? warning,
      warning,
      Number(warning.split(":")[1]) || undefined,
    );
  for (const at of runOf(
    scenes.map((s) => s.layoutId),
    PACING.maxSameLayoutRun,
  ))
    add("warn", "repeated_layout", `layout repeated through scene ${at + 1}`, at + 1);
  for (const at of runOf(
    scenes.map((s) => s.camera.shot),
    PACING.maxSameShotRun,
  ))
    add("info", "repeated_shot", `same shot through scene ${at + 1}`, at + 1);
  for (const [i, scene] of scenes.entries()) {
    const signature = sceneSignature(scene);
    const lookback = scenes.slice(Math.max(0, i - PACING.signatureWindow), i);
    if (lookback.some((other) => sceneSignature(other) === signature))
      add("info", "repeated_visual_signature", "same picture as a recent scene", i + 1);
  }
  const explanations = scenes.filter((s) => s.purpose === "explanation").length;
  if (scenes.length > 0 && explanations / scenes.length > PACING.maxExplanationShare)
    add("warn", "explanation_heavy", `${explanations} of ${scenes.length} scenes explain`);
  for (const chapter of input.chapters ?? []) {
    const seconds =
      (sceneWordCount(body.slice(chapter.fromChar, chapter.toChar)) * msPerWord) / 1000;
    if (seconds > PACING.maxChapterSeconds)
      add("warn", "chapter_too_long", `chapter ${chapter.index} runs ${Math.round(seconds)} s`);
  }
  return findings;
};

export const pacingBlocked = (findings: readonly PacingFinding[]): boolean =>
  findings.some((finding) => finding.severity === "block");
