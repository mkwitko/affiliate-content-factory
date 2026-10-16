import type { WorkspaceId } from "@money-maker/contracts";
import { directorPlanSchema } from "@money-maker/contracts/scene-spec-schema";
import type { Diagram } from "../explainer/diagrams.js";
import { resolveLocationScene } from "../explainer/locations.js";
import type {
  SceneDirector,
  SceneDirectorCorrection,
  SceneDirectorInput,
} from "../explainer/scene-director.js";
import {
  collectSceneSpecIssues,
  type SceneSpec,
  type SceneSpecIssue,
} from "../explainer/scene-spec.js";
import { applyDirectorIntents } from "./director-intents.js";
import {
  compileDirectorPlan,
  directorPlanCatalog,
  normalizeCameraSequence,
  normalizeDirectorPlan,
  normalizeVisualSignatures,
  scriptSegments,
} from "./director-plan.js";
import { normalizeActionTimings } from "./director-timing.js";
import { createStoryboard } from "./storyboard.js";

/** One direction job per approved script (scripts are immutable, so the key never goes stale). */
export const createDirectScenesJob = (input: { workspaceId: WorkspaceId; scriptId: string }) => ({
  name: "direct_scenes",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { scriptId: input.scriptId },
  },
  idempotencyKey: `direct-scenes:${input.scriptId}`,
  attemptPolicy: { maxAttempts: 2 },
});

export type DirectFailureReason =
  | "script_not_approved"
  | "director_unavailable"
  | "output_not_json"
  | "output_invalid"
  | "scene_rejected"
  | "guard_rejected";
/** A scene issue whose code may also be a zod, location, coverage or copy-integrity id. */
export type DirectorIssue = Readonly<Omit<SceneSpecIssue, "code"> & { code: string }>;
/** `errors` is `issues` rendered one line each, for logs and the correction prompt. */
export type DirectAttempt = Readonly<{
  reason: DirectFailureReason;
  errors: readonly string[];
  issues: readonly DirectorIssue[];
}>;
/** `attempts` lists the rejected attempts, so a first-try success has none. */
export type DirectScenesResult =
  | Readonly<{ ok: true; scenes: readonly SceneSpec[]; attempts: readonly DirectAttempt[] }>
  | Readonly<{ ok: false; reason: DirectFailureReason; attempts: readonly DirectAttempt[] }>;

const MAX_ATTEMPTS = 2;
const MAX_ERRORS = 20;
/** createStoryboard is the one storyboard gate; these placeholders never leave this module. */
const CHECK_VOICE_ID = "director_check";

const NUMBER = /\d+(?:[.,]\d+)*/g;
/** Every value a written number can mean: 1.500 is 1500 or 1.5, 329,90 is 329.9. */
const readings = (token: string): readonly number[] =>
  [
    Number(token.replace(/[.,]/g, "")),
    Number(token.replace(/\./g, "").replace(",", ".")),
    Number(token.replace(/,/g, "")),
  ].filter(Number.isFinite);

const diagramTexts = (diagram: Diagram): readonly string[] => {
  switch (diagram.kind) {
    case "flow":
      return [
        ...diagram.nodes.map((node) => node.label),
        ...diagram.edges.flatMap((edge) => (edge.label ? [edge.label] : [])),
      ];
    case "bar_compare":
      return diagram.items.map((item) => item.label);
    case "timeline":
      return diagram.points.flatMap((point) => [point.label, point.at]);
    case "before_after":
      return [diagram.before, diagram.after];
    case "percent":
      return [diagram.label];
    case "counter":
      return [];
  }
};
const diagramValues = (diagram: Diagram): readonly number[] =>
  diagram.kind === "bar_compare"
    ? diagram.items.map((item) => item.value)
    : diagram.kind === "counter"
      ? [diagram.from, diagram.to]
      : diagram.kind === "percent"
        ? [diagram.value]
        : [];

/**
 * Commercial guard (spec 5.7.5, "no factual or commercial change"): every number drawn on screen
 * must be written in the script. Zero is allowed as a counter or axis start.
 */
export const inventedNumbers = (scenes: readonly SceneSpec[], body: string): readonly string[] => {
  const allowed = new Set([...body.matchAll(NUMBER)].flatMap(([token]) => readings(token)));
  const problems: string[] = [];
  for (const scene of scenes) {
    const texts = [
      ...scene.overlays.map((overlay) => overlay.text),
      ...scene.props.flatMap((prop) => (prop.label ? [prop.label] : [])),
      ...(scene.diagram ? diagramTexts(scene.diagram) : []),
    ];
    for (const text of texts)
      for (const [token] of text.matchAll(NUMBER))
        if (!readings(token).some((value) => allowed.has(value)))
          problems.push(`number_not_in_script:${scene.index}:${token}`);
    for (const value of scene.diagram ? diagramValues(scene.diagram) : [])
      if (value !== 0 && !allowed.has(value))
        problems.push(`number_not_in_script:${scene.index}:${value}`);
  }
  return problems;
};

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Copy integrity (v2 spec 14.2), deterministic: numbers must be written in the script (the
 * `inventedNumbers` guard, reported alone when it fires), and every other rendered text must be
 * a verbatim substring of the approved script or a catalog label (a prop id read as words).
 * ponytail: captions are cut from the script by construction, so only overlays, prop labels
 * and diagram labels are checked.
 */
export const copyIntegrityCheck = (
  scenes: readonly SceneSpec[],
  body: string,
  catalogLabels: readonly string[] = [],
): readonly string[] => {
  const numbers = inventedNumbers(scenes, body);
  if (numbers.length > 0) return numbers;
  const script = norm(body);
  const labels = new Set(catalogLabels.map(norm));
  return scenes.flatMap((scene) =>
    [
      ...scene.overlays.map((overlay) => overlay.text),
      ...scene.props.flatMap((prop) => (prop.label ? [prop.label] : [])),
      ...(scene.diagram ? diagramTexts(scene.diagram) : []),
    ]
      .filter((text) => !script.includes(norm(text)) && !labels.has(norm(text)))
      .map((text) => `text_not_in_script:${scene.index}:${text}`),
  );
};

export type DirectorCheck =
  | Readonly<{ ok: true; scenes: readonly SceneSpec[] }>
  | Readonly<{ ok: false; failure: DirectAttempt }>;

const renderIssue = (issue: DirectorIssue): string => {
  const where = [
    issue.sceneIndex === undefined ? "" : `scene ${issue.sceneIndex}`,
    issue.field ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${where ? `${where} ` : ""}[${issue.code}]: ${issue.message}${
    issue.expected ? `; expected ${issue.expected}` : ""
  }${issue.actual ? `, got ${issue.actual}` : ""}`;
};

/** "number_not_in_script:2:70" / "text_not_in_script:2:some text" as a structured issue. */
const copyIssue = (problem: string): DirectorIssue => {
  const [code = problem, scene, ...rest] = problem.split(":");
  const sceneIndex = Number(scene);
  return {
    code,
    ...(Number.isInteger(sceneIndex) ? { sceneIndex } : {}),
    field: "text",
    actual: rest.join(":"),
    message:
      code === "number_not_in_script"
        ? "Remove the number or use one written in the script"
        : "Use only words written in the script",
  };
};

/**
 * The director gate (plan Zod, plan compile, locations, createStoryboard, copy integrity);
 * exported for ADR 0012 results.
 */
export const checkDirectorOutput = (raw: unknown, input: SceneDirectorInput): DirectorCheck => {
  const fail = (reason: DirectFailureReason, issues: readonly DirectorIssue[]): DirectorCheck => {
    const kept = issues.slice(0, MAX_ERRORS);
    return {
      ok: false,
      failure: {
        reason,
        errors: kept.map((issue) =>
          issue.code === "output_invalid" || issue.code === "output_not_json"
            ? `${issue.field ? `${issue.field}: ` : ""}${issue.message}`
            : renderIssue(issue),
        ),
        issues: kept,
      },
    };
  };
  if (typeof raw === "string")
    return fail("output_not_json", [
      { code: "output_not_json", message: "output is not the requested JSON" },
    ]);
  const expectedSegmentCount = scriptSegments(input.script.body).length;
  const parsed = directorPlanSchema(directorPlanCatalog(input), expectedSegmentCount).safeParse(
    raw,
  );
  if (!parsed.success)
    return fail(
      "output_invalid",
      parsed.error.issues.map((issue) => ({
        code: "output_invalid",
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  const plan = normalizeDirectorPlan(parsed.data, input.script.body, input.catalog);
  const compiled = compileDirectorPlan(
    plan,
    input.script.body,
    input.script.claims,
    input.script.language,
  );
  if (!compiled.ok) return fail("scene_rejected", compiled.issues);
  // Location, zone and anchor ids become today's fields, as in create_video_storyboard.
  const resolved: SceneSpec[] = [];
  const locationIssues: DirectorIssue[] = [];
  for (const scene of compiled.scenes) {
    const resolution = resolveLocationScene(scene, input.locations ?? []);
    if (resolution.ok) resolved.push(resolution.scene);
    else
      locationIssues.push({
        code: `location_${resolution.reason}`,
        sceneIndex: scene.index,
        field: "locationId",
        message: "Use a location, zone and anchor from the catalog",
      });
  }
  if (locationIssues.length > 0) return fail("scene_rejected", locationIssues);
  // Intents and mechanical direction rules run on resolved scenes, so anchors and plates are final.
  const timed = normalizeActionTimings(resolved, input.script.body, input.script.language);
  const intended = applyDirectorIntents(timed, {
    body: input.script.body,
    language: input.script.language,
    claims: input.script.claims,
    beats: input.script.beats,
    characters: input.persona,
    catalog: input.catalog,
  });
  const scenes = normalizeVisualSignatures(
    normalizeCameraSequence(intended, input.catalog, input.locations ?? []),
    input.catalog,
  );
  const copy = (): readonly DirectorIssue[] =>
    copyIntegrityCheck(
      scenes,
      input.script.body,
      input.catalog.props.map((prop) => prop.replaceAll("_", " ")),
    ).map(copyIssue);
  try {
    createStoryboard({
      workspaceId: input.script.workspaceId,
      script: input.script,
      version: 1,
      renderer: "stickman_motion",
      scenes,
      assets: [],
      characters: input.persona,
      voiceId: CHECK_VOICE_ID,
      canvas: "portrait",
      actorId: input.script.actorId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "storyboard_invalid";
    if (!message.startsWith("storyboard_scene_invalid:"))
      // Coverage and scene count are root causes: every other check would be noise.
      return fail("scene_rejected", [
        {
          code: message.split(":")[0] ?? "storyboard_invalid",
          message:
            message === "storyboard_coverage_invalid"
              ? "Cover the whole script in order: scenes must be contiguous, start at char 0 and end at the script length, without changing its text"
              : message.startsWith("storyboard_asset_invalid")
                ? "Do not set background asset ids"
                : "Return between 3 and the allowed number of scenes, numbered from 1",
        },
      ]);
    const sceneIssues = collectSceneSpecIssues({
      scenes,
      characters: input.persona,
      claims: input.script.claims,
      renderer: "stickman_motion",
      language: input.script.language,
      sceneTexts: scenes.map((scene) => input.script.body.slice(scene.fromChar, scene.toChar)),
    });
    return fail("scene_rejected", [
      ...(sceneIssues.length > 0
        ? sceneIssues
        : [{ code: message.split(":")[2] ?? "storyboard_invalid", message }]),
      ...copy(),
    ]);
  }
  const problems = copy();
  return problems.length > 0 ? fail("guard_rejected", problems) : { ok: true, scenes };
};

/**
 * Approved script -> director plan -> Zod -> compile -> createStoryboard (coverage, scene count,
 * validateSceneSpecs) -> number guard. One attempt plus one correction fed with the errors
 * (spec 5.7.2). Output that fails is never repaired; the caller keeps the ChatGPT storyboard.
 */
export const directScenes = async (
  director: SceneDirector,
  input: SceneDirectorInput,
): Promise<DirectScenesResult> => {
  if (input.script.status !== "approved")
    return { ok: false, reason: "script_not_approved", attempts: [] };
  const segmentCount = scriptSegments(input.script.body).length;
  if (segmentCount < 3) {
    const issue: DirectorIssue = {
      code: "scene_count_unavailable",
      expected: "at least 3 script segments",
      actual: String(segmentCount),
      message: "The script is too short for the storyboard scene-count rules",
    };
    const failure: DirectAttempt = {
      reason: "scene_rejected",
      errors: [renderIssue(issue)],
      issues: [issue],
    };
    return { ok: false, reason: failure.reason, attempts: [failure] };
  }
  const attempts: DirectAttempt[] = [];
  let correction: SceneDirectorCorrection | undefined;
  for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
    let raw: unknown;
    try {
      raw = await director.direct(correction ? { ...input, correction } : input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "director_failed";
      attempts.push({
        reason: "director_unavailable",
        errors: [message],
        issues: [{ code: "director_unavailable", message }],
      });
      return { ok: false, reason: "director_unavailable", attempts };
    }
    const result = checkDirectorOutput(raw, input);
    if (result.ok) return { ok: true, scenes: result.scenes, attempts };
    attempts.push(result.failure);
    correction = { previous: raw, errors: result.failure.errors };
  }
  return {
    ok: false,
    reason: attempts.at(-1)?.reason ?? "output_invalid",
    attempts,
  };
};
