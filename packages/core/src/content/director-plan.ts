import type {
  DirectorPlan,
  DirectorPlanSegment,
  SceneSpecCatalog,
} from "@money-maker/contracts/scene-spec-schema";
import type { StagePosition } from "../explainer/layout.js";
import { type Location, shotRuleViolation } from "../explainer/locations.js";
import type { SceneDirectorInput } from "../explainer/scene-director.js";
import {
  MAX_EXPLANATION_RUN,
  MAX_PROPS,
  NARRATION_WORD,
  SCENE_PURPOSES,
  type ScenePurpose,
  type SceneSpec,
  sceneSignature,
} from "../explainer/scene-spec.js";
import { SHOT_KINDS, SHOT_RULES } from "../explainer/shots.js";
import type { DirectorIssue } from "./direct-scenes.js";
import type { ClaimKind } from "./editorial.js";

/**
 * The director chooses semantic cuts and visual direction. Core derives offsets from the
 * segment flags, copies overlay text from the approved script, and keeps the existing final gates.
 */

export type ScriptSegment = Readonly<{
  fromChar: number;
  toChar: number;
  text: string;
  words: readonly string[];
}>;

export type DirectorSceneBoundary = ScriptSegment &
  Readonly<{ firstSegment: number; lastSegment: number }>;

/**
 * Sentence segments with their character offsets. A boundary is sentence punctuation followed
 * by whitespace or the end,
 * so "1.500" and "329,90" never split. Segments cover the body exactly, whitespace included.
 */
export const scriptSegments = (body: string): readonly ScriptSegment[] => {
  const segment = (fromChar: number, toChar: number): ScriptSegment => {
    const text = body.slice(fromChar, toChar);
    return { fromChar, toChar, text, words: [...text.matchAll(NARRATION_WORD)].map(([w]) => w) };
  };
  const segments: ScriptSegment[] = [];
  let from = 0;
  for (const match of body.matchAll(/[.!?]+(?:\s+|$)/g)) {
    const to = match.index + match[0].length;
    segments.push(segment(from, to));
    from = to;
  }
  if (from < body.length) segments.push(segment(from, body.length));
  // Very short sentence lists still need enough word boundaries to satisfy the 3-scene gate.
  while (segments.length < 3) {
    const candidate = segments
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value.words.length > 1)
      .sort((a, b) => b.value.words.length - a.value.words.length)[0];
    if (!candidate) break;
    const words = [...candidate.value.text.matchAll(NARRATION_WORD)];
    const split = words[Math.ceil(words.length / 2)];
    const at = candidate.value.fromChar + (split?.index ?? 0);
    if (at <= candidate.value.fromChar || at >= candidate.value.toChar) break;
    segments.splice(
      candidate.index,
      1,
      segment(candidate.value.fromChar, at),
      segment(at, candidate.value.toChar),
    );
  }
  return segments;
};

/** Make a model's cut count legal while preserving its visual choice at retained scene starts. */
export const normalizeDirectorPlan = (
  plan: DirectorPlan,
  body: string,
  catalog: SceneDirectorInput["catalog"],
): DirectorPlan => {
  const entries = [...plan.segments];
  const segments = scriptSegments(body);
  const sceneStarts = () => entries.flatMap((entry, index) => (entry.newScene ? [index] : []));
  if (entries[0] && !entries[0].newScene) {
    const source = entries.find((entry) => entry.newScene);
    if (source?.newScene)
      entries[0] = { newScene: true, visual: { ...source.visual, purpose: "hook" } };
  }
  while (sceneStarts().length > 12) {
    const starts = sceneStarts();
    const smallest = starts
      .map((start, i) => {
        const end = starts[i + 1] ?? entries.length;
        const words = segments.slice(start, end).reduce((sum, part) => sum + part.words.length, 0);
        return { start, words };
      })
      .filter(({ start }) => start > 0)
      .sort((a, b) => a.words - b.words)[0];
    if (!smallest) break;
    entries[smallest.start] = { newScene: false };
  }
  while (sceneStarts().length < 3) {
    const starts = sceneStarts();
    const split = starts
      .map((start, i) => ({ start, end: starts[i + 1] ?? entries.length }))
      .filter(({ start, end }) => end - start > 1)
      .sort((a, b) => {
        const wordCount = (scene: { start: number; end: number }) =>
          segments.slice(scene.start, scene.end).reduce((sum, part) => sum + part.words.length, 0);
        return wordCount(b) - wordCount(a);
      })[0];
    if (!split) break;
    const midpoint = split.start + Math.ceil((split.end - split.start) / 2);
    const opener = entries[split.start];
    if (!opener?.newScene) break;
    const visual = opener.visual;
    const distinctVisual =
      visual.actors.length > 0
        ? {
            ...visual,
            actors: visual.actors.map((actor, index) =>
              index === 0
                ? {
                    ...actor,
                    pose:
                      catalog.poses.find(
                        (pose) => pose !== actor.pose && !(actor.anchorId && pose === "neutral"),
                      ) ?? actor.pose,
                  }
                : actor,
            ),
          }
        : {
            ...visual,
            background:
              catalog.backgrounds.find((background) => background !== visual.background) ??
              visual.background,
          };
    const leftWords = segments
      .slice(split.start, midpoint)
      .reduce((sum, part) => sum + part.words.length, 0);
    const actionsBeforeCut = <T extends { atWord: number }>(actions: readonly T[] | undefined) =>
      actions?.filter((action) => action.atWord < leftWords);
    const actionsAfterCut = <T extends { atWord: number }>(actions: readonly T[] | undefined) =>
      actions?.flatMap((action) =>
        action.atWord >= leftWords ? [{ ...action, atWord: action.atWord - leftWords } as T] : [],
      );
    entries[split.start] = {
      newScene: true,
      visual: {
        ...visual,
        purpose: visual.purpose === "hook" ? "setup" : visual.purpose,
        actors: visual.actors.map((actor) => ({
          ...actor,
          actions: actionsBeforeCut(actor.actions),
          ...(actor.motionTokens
            ? {
                motionTokens: actionsBeforeCut(actor.motionTokens as readonly { atWord: number }[]),
              }
            : {}),
        })),
        overlays: [],
      },
    };
    entries[midpoint] = {
      newScene: true,
      visual: {
        ...distinctVisual,
        actors: distinctVisual.actors.map((actor) => ({
          ...actor,
          actions: actionsAfterCut(actor.actions),
          ...(actor.motionTokens
            ? {
                motionTokens: actionsAfterCut(actor.motionTokens as readonly { atWord: number }[]),
              }
            : {}),
        })),
        overlays: [],
      },
    };
  }
  const enforcePurposes = () => {
    const starts = sceneStarts();
    const first = entries[starts[0] ?? -1];
    if (first?.newScene && first.visual.purpose !== "hook")
      entries[starts[0] ?? 0] = { ...first, visual: { ...first.visual, purpose: "hook" } };
    const hasPayoff = starts.some((index) => {
      const entry = entries[index];
      return entry?.newScene && entry.visual.purpose === "payoff";
    });
    if (!hasPayoff) {
      const last = starts.at(-1);
      const entry = last === undefined ? undefined : entries[last];
      if (last !== undefined && entry?.newScene)
        entries[last] = { ...entry, visual: { ...entry.visual, purpose: "payoff" } };
    }
  };
  enforcePurposes();
  // purpose_sequence made mechanical: in a run of more than MAX_EXPLANATION_RUN explanation
  // scenes, the cut before the run's smallest later scene is redundant, so that scene joins the
  // explanation before it (fewest words, then earliest). Purposes are never relabeled; the
  // retained scene keeps its visual and its word-anchored actions, which stay inside it.
  while (sceneStarts().length > 3) {
    const starts = sceneStarts();
    // The first run that is too long, whole.
    let run: number[] = [];
    let tooLong: number[] = [];
    for (const [i, start] of starts.entries()) {
      const entry = entries[start];
      run = entry?.newScene && entry.visual.purpose === "explanation" ? [...run, i] : [];
      if (run.length > MAX_EXPLANATION_RUN) tooLong = run;
      else if (tooLong.length > 0) break;
    }
    const smallest = tooLong
      .slice(1)
      .map((i) => {
        const start = starts[i] ?? 0;
        const end = starts[i + 1] ?? entries.length;
        const words = segments.slice(start, end).reduce((sum, part) => sum + part.words.length, 0);
        return { start, words };
      })
      .sort((a, b) => a.words - b.words || a.start - b.start)[0];
    if (!smallest) break;
    entries[smallest.start] = { newScene: false };
  }
  enforcePurposes();
  return { segments: entries } as DirectorPlan;
};

/** Compile per-segment cut choices to exact contiguous script boundaries. */
export type DirectorSceneBoundaryResult =
  | Readonly<{ ok: true; boundaries: readonly DirectorSceneBoundary[] }>
  | Readonly<{ ok: false; issue: DirectorIssue }>;

export const directorSceneBoundaries = (
  body: string,
  newScenes: readonly boolean[],
): DirectorSceneBoundaryResult => {
  const segments = scriptSegments(body);
  if (newScenes.length !== segments.length)
    return {
      ok: false,
      issue: {
        code: "segment_count_mismatch",
        field: "segments",
        expected: String(segments.length),
        actual: String(newScenes.length),
        message: "Return one cut decision for each script segment",
      },
    };
  if (segments.length > 0 && newScenes[0] !== true)
    return {
      ok: false,
      issue: {
        code: "first_scene_missing",
        field: "segments[0].newScene",
        expected: "true",
        actual: "false",
        message: "The first script segment must start the first scene",
      },
    };
  const starts = newScenes.flatMap((startsScene, index) => (startsScene ? [index] : []));
  if (starts.length < 3 || starts.length > 12)
    return {
      ok: false,
      issue: {
        code: "scene_count_out_of_range",
        field: "segments",
        expected: `3 to ${Math.min(segments.length, 12)}`,
        actual: String(starts.length),
        message: "Choose between 3 and 12 scenes, no more than the available segments",
      },
    };
  const boundaries = starts.map((firstIndex, index) => {
    const endIndex = starts[index + 1] ?? segments.length;
    const first = segments[firstIndex];
    const last = segments[endIndex - 1];
    const firstSegment = firstIndex + 1;
    const lastSegment = endIndex;
    const text = body.slice(first?.fromChar ?? 0, last?.toChar ?? 0);
    return {
      fromChar: first?.fromChar ?? 0,
      toChar: last?.toChar ?? 0,
      text,
      words: [...text.matchAll(NARRATION_WORD)].map(([word]) => word),
      firstSegment,
      lastSegment,
    };
  });
  return { ok: true, boundaries };
};

/** Shots with no actor or prop requirement: any scene the model draws fits them. */
export const DIRECTOR_SHOTS = SHOT_KINDS.filter((shot) => {
  const rule = SHOT_RULES[shot];
  return rule.minActors === 0 && rule.maxActors >= 3 && !rule.needsProp;
});

type Names = readonly [string, ...string[]];
const names = (values: readonly string[]): Names | undefined => {
  const unique = [...new Set(values)];
  return unique.length > 0 ? (unique as unknown as Names) : undefined;
};

/** The vocabulary of one direction: the rig catalog, the cast and the niche's locations. */
export const directorPlanCatalog = (input: SceneDirectorInput): SceneSpecCatalog => {
  const locations = input.locations ?? [];
  const shots = (input.catalog.shots ?? SHOT_KINDS).filter((shot) => DIRECTOR_SHOTS.includes(shot));
  return {
    purposes: SCENE_PURPOSES,
    ...input.catalog,
    shots: names(shots),
    layouts: undefined,
    characterKeys: names(input.persona.map((character) => character.key)),
    locationIds: names(locations.map((location) => location.id)),
    zoneIds: names(locations.flatMap((location) => location.zones.map((zone) => zone.id))),
    anchorIds: names(locations.flatMap((location) => location.anchors.map((anchor) => anchor.id))),
  };
};

export type CompiledPlan =
  | Readonly<{ ok: true; scenes: readonly SceneSpec[] }>
  | Readonly<{ ok: false; issues: readonly DirectorIssue[] }>;

/** On-screen text limit shared by overlays and diagram labels. */
const EXCERPT_CHARS = 24;
/**
 * The longest run of whole words of `text` starting at `start` that fits 24 characters,
 * copied literally; undefined when the first word alone is longer.
 */
export const literalExcerpt = (text: string, start: number): string | undefined => {
  const words = [...text.matchAll(NARRATION_WORD)].filter(
    (word) => word.index >= start && word.index + word[0].length - start <= EXCERPT_CHARS,
  );
  const last = words.at(-1);
  return last ? text.slice(start, last.index + last[0].length).trimEnd() || undefined : undefined;
};

type DirectorClaim = Readonly<{ text: string; kind: ClaimKind }>;
const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;
/** The value a written number has in the script's language: 1.500 is 1500 and 329,90 is 329.9 in pt. */
export const scriptNumberValue = (token: string, language: string): number =>
  Number(
    language.toLowerCase().startsWith("en")
      ? token.replace(/,/g, "")
      : token.replace(/\./g, "").replace(",", "."),
  );

/** Measurement words a counter may show after its figure; anything else is left off. */
const UNIT_WORDS = new Set(
  "h horas hora min minutos segundos dias meses anos w watts kwh v mah l litros ml kg g gramas m metros cm mm gb mb tb hours hour minutes seconds days months years liters litres grams meters".split(
    " ",
  ),
);

/**
 * Claim visualization: the director names a claim and a diagram kind; the figure comes from the
 * claim. Only a verified fact qualifies, and only a number written both in the claim and in the
 * script. A percent needs "%" after the number in the script and takes a literal script excerpt
 * as its label; a counter runs from 0 and shows the claim's next word only when it is a unit.
 * Anything else yields no diagram.
 */
export const claimDiagram = (
  kind: "counter" | "percent",
  claimRef: number,
  claims: readonly DirectorClaim[],
  body: string,
  language: string,
): SceneSpec["diagram"] => {
  const claim = claims[claimRef];
  if (claim?.kind !== "verified_fact") return undefined;
  for (const { 0: token, index } of claim.text.matchAll(NUMBER_TOKEN)) {
    const at = [...body.matchAll(NUMBER_TOKEN)].find(([written]) => written === token)?.index;
    const value = scriptNumberValue(token, language);
    if (at === undefined || !Number.isFinite(value)) continue;
    const after = body.slice(at + token.length);
    if (kind === "percent") {
      if (!/^\s?%/.test(after) || value > 100) continue;
      const label = literalExcerpt(body, at);
      if (label) return { kind, value, label, claimRef };
      continue;
    }
    const next = /^\s*(\p{L}+)/u.exec(claim.text.slice(index + token.length))?.[1];
    const unit = next && UNIT_WORDS.has(next.toLowerCase()) ? next : undefined;
    return { kind, from: 0, to: value, ...(unit ? { unit } : {}), claimRef };
  }
  return undefined;
};

/**
 * Plan -> SceneSpec, deterministic. The model marks scene starts; core derives boundaries,
 * copies overlay text from each scene's script slice and builds numeric diagrams from claims
 * before the existing validators run.
 */
export const compileDirectorPlan = (
  plan: DirectorPlan,
  body: string,
  claims: readonly DirectorClaim[] = [],
  language = "pt-BR",
): CompiledPlan => {
  const boundaryResult = directorSceneBoundaries(
    body,
    plan.segments.map((segment) => segment.newScene),
  );
  if (!boundaryResult.ok) return { ok: false, issues: [boundaryResult.issue] };
  const boundaries = boundaryResult.boundaries;
  const scenes: SceneSpec[] = [];
  let sceneIndex = 0;
  for (const planned of plan.segments) {
    if (!planned.newScene) continue;
    const { overlays, diagram: directed, ...rest } = planned.visual;
    const index = sceneIndex + 1;
    const boundary = boundaries[sceneIndex];
    sceneIndex += 1;
    if (!boundary) continue;
    const { fromChar } = boundary;
    const text = boundary.text;
    const words = [...text.matchAll(NARRATION_WORD)];
    const copied: SceneSpec["overlays"][number][] = [];
    for (const overlay of overlays) {
      const anchor = words.find(
        (word) => word[0]?.toLowerCase() === overlay.anchorWord.toLowerCase(),
      );
      const excerpt = anchor ? literalExcerpt(text, anchor.index) : undefined;
      if (!excerpt) continue;
      copied.push({
        text: excerpt,
        position: overlay.position,
        ...(overlay.emphasis !== undefined ? { emphasis: overlay.emphasis } : {}),
      });
    }
    const diagram =
      directed?.kind === "counter" || directed?.kind === "percent"
        ? claimDiagram(directed.kind, directed.claimRef, claims, body, language)
        : (directed as SceneSpec["diagram"]);
    // The schema was built from the catalog, so every string is a catalog member.
    scenes.push({
      ...(rest as unknown as Omit<SceneSpec, "overlays" | "diagram">),
      ...(diagram ? { diagram } : {}),
      index,
      fromChar,
      toChar: boundary.toChar,
      overlays: copied,
    });
  }
  const quota = Math.ceil(scenes.length * 0.3);
  const priority = (purpose: SceneSpec["purpose"]) =>
    purpose === "hook" ? 0 : purpose === "payoff" ? 1 : purpose === "cta" ? 2 : 3;
  const keep = new Set(
    scenes
      .flatMap((scene, i) => (scene.overlays.length ? [{ i, score: priority(scene.purpose) }] : []))
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .slice(0, quota)
      .map(({ i }) => i),
  );
  return {
    ok: true,
    scenes: scenes.map((scene, i) => (keep.has(i) ? scene : { ...scene, overlays: [] })),
  };
};

type Camera = SceneSpec["camera"];
const sameCamera = (a: Camera, b: Camera): boolean =>
  a.shot === b.shot && a.movement === b.movement;
const MOTIVATED_MOVES: readonly string[] = ["push_in", "low_angle", "handheld"];
/** Moves that keep text and diagrams readable while they land (see motion-budget). */
const STILL_MOVES: readonly string[] = ["none", "handheld"];
const TENSION_PURPOSES: readonly ScenePurpose[] = ["escalation", "surprise"];

/**
 * camera_repeated made mechanical. Each scene is compared with the already normalized previous
 * one; a repeat keeps the shot and takes the first other movement, else keeps the movement and
 * takes the first other shot the zone and shot rules allow. Order is stable: catalog order, with
 * still moves first for a scene showing text or a diagram and motivated moves first for tension.
 * A choice that also differs from the next scene wins. Only catalog values; none left, the
 * validator still rejects.
 */
export const normalizeCameraSequence = (
  scenes: readonly SceneSpec[],
  catalog: SceneDirectorInput["catalog"],
  locations: readonly Location[],
): readonly SceneSpec[] => {
  const shots = (catalog.shots ?? SHOT_KINDS).filter((shot) => DIRECTOR_SHOTS.includes(shot));
  const result: SceneSpec[] = [];
  for (const [index, scene] of scenes.entries()) {
    const previous = result[index - 1];
    if (!previous || !sameCamera(previous.camera, scene.camera)) {
      result.push(scene);
      continue;
    }
    const preferred =
      scene.overlays.length > 0 || scene.diagram !== undefined
        ? STILL_MOVES
        : TENSION_PURPOSES.includes(scene.purpose)
          ? MOTIVATED_MOVES
          : [];
    // Array#sort is stable, so catalog order survives inside each rank.
    const movements = [...catalog.cameraMovements].sort(
      (a, b) => Number(!preferred.includes(a)) - Number(!preferred.includes(b)),
    );
    const zone = locations
      .find((location) => location.id === scene.locationId)
      ?.zones.find((entry) => entry.id === scene.zoneId);
    const candidates = [
      ...movements.map((movement) => ({ shot: scene.camera.shot, movement })),
      ...shots
        .filter((shot) => !zone || zone.allowedShots.includes(shot))
        .map((shot) => ({ shot, movement: scene.camera.movement })),
    ].filter(
      (camera) =>
        !sameCamera(camera, previous.camera) && shotRuleViolation({ ...scene, camera }) === null,
    );
    const next = scenes[index + 1];
    const camera =
      candidates.find((option) => !next || !sameCamera(option, next.camera)) ?? candidates[0];
    result.push(camera ? { ...scene, camera } : scene);
  }
  return result;
};

const STAGE_POSITIONS: readonly StagePosition[] = ["left", "center", "right"];
/** Calm poses that keep the beat: no locomotion, seat, held object or reaction. */
const SWAP_POSES = ["thinking", "neutral", "pointing"] as const;
const LOCOMOTION: readonly string[] = ["enter", "exit", "walk_to"];

/**
 * repeated_scene made mechanical. A scene drawn like the already normalized previous one takes
 * the first candidate that changes the picture, in this order: one actor's stage position (not
 * for anchored or moving actors), one actor's calm pose, a prop the storyboard already shows
 * (nearest scene first), then a background (storyboard ones first, never on a location). The
 * cast never changes; with no candidate the validator still rejects.
 */
export const normalizeVisualSignatures = (
  scenes: readonly SceneSpec[],
  catalog: SceneDirectorInput["catalog"],
): readonly SceneSpec[] => {
  const result: SceneSpec[] = [];
  for (const [index, scene] of scenes.entries()) {
    const previous = result[index - 1];
    if (!previous || sceneSignature(previous) !== sceneSignature(scene)) {
      result.push(scene);
      continue;
    }
    const withActor = (at: number, actor: SceneSpec["actors"][number]): SceneSpec => ({
      ...scene,
      actors: scene.actors.map((current, i) => (i === at ? actor : current)),
    });
    const nearest = scenes
      .map((other, i) => ({ other, distance: Math.abs(i - index) }))
      .filter(({ distance }) => distance > 0)
      .sort((a, b) => a.distance - b.distance)
      .map(({ other }) => other);
    const positions = scene.actors.flatMap((actor, at) =>
      actor.anchorId !== undefined ||
      (actor.motionTokens?.length ?? 0) > 0 ||
      actor.actions?.some((action) => LOCOMOTION.includes(action.type))
        ? []
        : STAGE_POSITIONS.filter(
            (position) => !scene.actors.some((other) => other.position === position),
          ).map((position) => withActor(at, { ...actor, position })),
    );
    const poses = scene.actors.flatMap((actor, at) =>
      actor.pose === "sitting"
        ? []
        : SWAP_POSES.filter(
            (pose) => pose !== actor.pose && (catalog.poses as readonly string[]).includes(pose),
          ).map((pose) => withActor(at, { ...actor, pose })),
    );
    const props =
      scene.props.length >= MAX_PROPS
        ? []
        : nearest
            .flatMap((other) => other.props)
            .filter(
              (prop, i, all) =>
                !scene.props.some((own) => own.type === prop.type) &&
                all.findIndex((first) => first.type === prop.type) === i,
            )
            .map((prop) => ({
              ...scene,
              props: [...scene.props, { type: prop.type, position: prop.position }],
            }));
    const backgrounds =
      scene.locationId !== undefined || scene.backgroundAssetId !== undefined
        ? []
        : [...new Set([...nearest.map((other) => other.background), ...catalog.backgrounds])]
            .filter((background) => background !== scene.background)
            .map((background) => ({ ...scene, background }));
    const before = sceneSignature(previous);
    result.push(
      [...positions, ...poses, ...props, ...backgrounds].find(
        (candidate) => sceneSignature(candidate) !== before,
      ) ?? scene,
    );
  }
  return result;
};

/**
 * SceneSpec -> semantic segment decisions, for tests and fixtures that replay authored output.
 */
export const directorPlanFrom = (scenes: readonly SceneSpec[], body: string): DirectorPlan => {
  const segments = scriptSegments(body);
  const visual = (scene: SceneSpec): Extract<DirectorPlanSegment, { newScene: true }>["visual"] => {
    const {
      fromChar,
      toChar,
      overlays,
      props,
      diagram,
      layoutId: _layout,
      dialogue: _dialogue,
      backgroundAssetId: _background,
      index: _index,
      ...rest
    } = scene;
    const text = body.slice(fromChar, toChar);
    const words = [...text.matchAll(NARRATION_WORD)];
    const directed =
      diagram?.kind === "counter" || diagram?.kind === "percent"
        ? diagram.claimRef === undefined
          ? undefined
          : { kind: diagram.kind, claimRef: diagram.claimRef }
        : diagram?.kind === "bar_compare"
          ? undefined
          : diagram;
    return {
      ...rest,
      ...(directed ? { diagram: directed } : {}),
      props: props.map((prop) => ({ type: prop.type, position: prop.position })),
      overlays: overlays.map((overlay) => {
        const start = text.indexOf(overlay.text);
        const fromWord = words.findIndex((word) => word.index >= start);
        return {
          anchorWord: words[fromWord]?.[0] ?? overlay.text.slice(0, 24),
          position: overlay.position,
          ...(overlay.emphasis !== undefined ? { emphasis: overlay.emphasis } : {}),
        };
      }),
    } as Extract<DirectorPlanSegment, { newScene: true }>["visual"];
  };
  return {
    segments: segments.map((segment) => {
      const scene = scenes.find((candidate) => candidate.fromChar === segment.fromChar);
      return scene
        ? { newScene: true as const, visual: visual(scene) }
        : { newScene: false as const };
    }),
  };
};
