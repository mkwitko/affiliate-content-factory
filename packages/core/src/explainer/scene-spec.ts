import {
  checkDialogue,
  type DialogueLine,
  type DialogueRejection,
  dialogueReactionTokens,
} from "./dialogue.js";
import type { LayoutId } from "./layouts.js";
import { type LocationLighting, sceneLayoutMismatch, shotRuleViolation } from "./locations.js";
import { SHOT_RULES, type ShotKind } from "./shots.js";
import {
  isKnownToken,
  MOTION_TOKENS,
  type MotionTokenId,
  type SceneMotionToken,
  withExpandedTokens,
} from "./motion-tokens.js";
import { type MotionBudgetWarning, motionBudgetWarnings } from "./motion-budget.js";
import { createHash } from "node:crypto";
import type { ClaimKind } from "../content/editorial.js";
import type { BackgroundId } from "./backgrounds.js";
import { type Diagram, diagramNumericRefs } from "./diagrams.js";
import type { ExplainerCharacter } from "./explainer-context.js";
import { type CanvasGeometry, PORTRAIT_GEOMETRY, positionX, type StagePosition } from "./layout.js";
import type { PropId } from "./props.js";
import { type ExpressionId, type PoseId, STICK_V1_ACTIONS } from "./rigs/stick-v1.js";
import { narrationMsPerWord } from "./script-guards.js";
import { canonicalJson } from "../shared/canonical-json.js";

/**
 * SceneSpec: the renderer-independent description of one explainer scene. The same spec feeds
 * the deterministic still composer today and, later, motion renderers or image-to-video
 * prompts. Every scene declares why it exists (purpose) so none is filler.
 */
export const SCENE_PURPOSES = [
  "hook",
  "setup",
  "question",
  "explanation",
  "escalation",
  "surprise",
  "payoff",
  "loop",
  "cta",
] as const;
export type ScenePurpose = (typeof SCENE_PURPOSES)[number];
/** What an action aims at: one of the scene's props or overlays (0-based index) or its diagram. */
export type ActionTarget =
  | Readonly<{ kind: "prop"; index: number }>
  | Readonly<{ kind: "diagram" }>
  | Readonly<{ kind: "overlay"; index: number }>;
/** What a look_at aims at: any action target, or another actor of the same scene. */
export type LookTarget = ActionTarget | Readonly<{ kind: "actor"; characterKey: string }>;
/** Emotions an actor plays with its whole body; the motion planner expands each into primitives. */
export const EMOTIONS = ["frustrated", "excited", "searching", "worried", "triumphant"] as const;
export type Emotion = (typeof EMOTIONS)[number];
/**
 * Something an actor does during the scene, anchored to a narration word: atWord is the 0-based
 * index of the word in the scene's text (tokenised like the timing manifest, see sceneWordCount).
 * Only the stickman_motion renderer performs actions.
 */
/** Motion budget category of an action (v2 slice 16); absent counts as primary. */
export type ActionPriority = "primary" | "secondary" | "ambient";
export type ActorAction = (
  | Readonly<{ type: "enter"; atWord: number; from: "left" | "right"; durationMs?: number }>
  | Readonly<{ type: "exit"; atWord: number; to: "left" | "right"; durationMs?: number }>
  | Readonly<{ type: "walk_to"; atWord: number; to: StagePosition; durationMs?: number }>
  | Readonly<{ type: "pose"; atWord: number; pose: PoseId; durationMs?: number }>
  | Readonly<{ type: "expression"; atWord: number; expression: ExpressionId }>
  | Readonly<{ type: "jump"; atWord: number; durationMs?: number }>
  | Readonly<{ type: "react"; atWord: number; mark: "exclaim" | "sparkle" }>
  | Readonly<{ type: "point_at"; atWord: number; target: ActionTarget; durationMs?: number }>
  | Readonly<{ type: "look_at"; atWord: number; target: LookTarget; durationMs?: number }>
  | Readonly<{ type: "emote"; atWord: number; emotion: Emotion; durationMs?: number }>
) &
  Readonly<{
    priority?: ActionPriority | undefined;
    /**
     * Internal (v2 slice 22): ms after the anchored word, set only by motion-token expansion;
     * the MCP schema never accepts it.
     */
    offsetMs?: number | undefined;
  }>;
export type ActorActionType = ActorAction["type"];
export type SceneActor = Readonly<{
  characterKey: string;
  pose: PoseId;
  expression: ExpressionId;
  position: StagePosition;
  facing?: "left" | "right" | undefined;
  scale?: number | undefined;
  actions?: readonly ActorAction[] | undefined;
  /** Named acting beats (v2 slice 22) that expand into actions; see motion-tokens.ts. */
  motionTokens?: readonly SceneMotionToken[] | undefined;
  /** A location anchor (v2 slice 23); resolved into position, facing and scale. */
  anchorId?: string | undefined;
}>;
export type SceneProp = Readonly<{
  type: PropId;
  position: StagePosition | "top";
  label?: string | undefined;
}>;
export type SceneOverlay = Readonly<{
  text: string;
  emphasis?: boolean | undefined;
  position: "top" | "middle";
}>;
/** Camera moves; push_in, low_angle and handheld are motivated moves drawn by stickman_motion. */
export const CAMERA_MOVEMENTS = [
  "none",
  "slow_zoom_in",
  "slow_zoom_out",
  "pan_left",
  "pan_right",
  "push_in",
  "low_angle",
  "handheld",
] as const;
export type SceneCamera = Readonly<{
  /** v2 slice 23 adds establishing, two_shot, over_shoulder, insert and pov. */
  shot: ShotKind;
  movement: (typeof CAMERA_MOVEMENTS)[number];
}>;
export type SceneSpec = Readonly<{
  index: number;
  fromChar: number;
  toChar: number;
  purpose: ScenePurpose;
  background: BackgroundId;
  /**
   * stickman_motion only: a painted background asset (role explainer_background) drawn instead of
   * the procedural `background`, which stays the fallback and the bank setting. Set by the MCP
   * storyboard tool from the niche bank; a scene director never proposes it.
   */
  backgroundAssetId?: string | undefined;
  actors: readonly SceneActor[];
  props: readonly SceneProp[];
  diagram?: Diagram | undefined;
  overlays: readonly SceneOverlay[];
  camera: SceneCamera;
  transition: "hard_cut" | "fade" | "wipe";
  captionMode: "word" | "line" | "none";
  /**
   * Motion grammar only (v2 slice 15): `intentional_still` freezes idle actors on purpose (no
   * breathing or weight shift, blinks stay) and exempts the scene from the dead-frame note;
   * absent or `moving` gives idle actors a moving hold. Ignored with the grammar off.
   */
  holdMode?: "moving" | "intentional_still" | undefined;
  /** v2 slice 23: a niche location and one of its camera zones, resolved at storyboard time. */
  locationId?: string | undefined;
  zoneId?: string | undefined;
  /** v2 slice 23: a registry layout (layouts.ts); the scene must fit it. */
  layoutId?: LayoutId | undefined;
  /** v2 slice 24: which of the location's lighting grades tints its plate. */
  lighting?: LocationLighting | undefined;
  /**
   * v2 slice 32: the scene's narration split into lines by speaker (script character ranges
   * covering the scene text in order). stickman_motion only.
   */
  dialogue?: readonly DialogueLine[] | undefined;
}>;
/** Same union as StoryboardScene["motion"]; declared here so explainer does not import content. */
export type SceneMotion = "static" | "ken_burns_in" | "ken_burns_out" | "pan_left" | "pan_right";

export type SceneSpecRejectionReason =
  | "purpose_sequence"
  | "character_missing"
  | "too_many_overlays"
  | "overlay_too_long"
  | "diagram_number_without_claim"
  | "repeated_scene"
  | "overlay_ratio"
  | "actors_limit"
  | "props_limit"
  | "actions_require_motion"
  | "action_unsupported"
  | "action_word_out_of_range"
  | "action_duration_invalid"
  | "action_overlap"
  | "action_exceeds_scene"
  | "actions_limit"
  | "action_target_missing"
  | "camera_repeated"
  | "background_asset_requires_motion"
  | "token_unknown"
  | "shot_capacity"
  | "shot_needs_prop"
  | "layout_actor_count"
  | "layout_actor_position"
  | "layout_needs_prop"
  | "layout_needs_diagram"
  | "layout_overlay_position"
  | "dialogue_requires_motion"
  | DialogueRejection;
export type SceneSpecRejection = Readonly<{ index: number; reason: SceneSpecRejectionReason }>;
export type SceneSpecVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; rejection: SceneSpecRejection }>;

const MAX_ACTORS = 3;
export const MAX_PROPS = 3;
const MAX_OVERLAYS = 2;
const MAX_OVERLAY_CHARS = 24;
export const MAX_EXPLANATION_RUN = 3;
/** Text on screen is emphasis, not a subtitle track: at most ~30% of scenes carry it. */
export const MAX_OVERLAY_SHARE = 0.3;

/** What a viewer perceives as "the same picture": setting, cast in pose, objects, diagram. */
export const sceneSignature = (scene: SceneSpec): string =>
  JSON.stringify({
    background: scene.background,
    painting: scene.backgroundAssetId ?? null,
    actors: scene.actors.map((actor) => `${actor.characterKey}:${actor.pose}:${actor.position}`),
    props: scene.props.map((prop) => prop.type),
    diagram: scene.diagram?.kind ?? null,
  });

/**
 * Narration words: runs of letters and digits, with apostrophes inside a word (didn't, it's) kept
 * in it, which is how the TTS speaks and times them.
 */
export const NARRATION_WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
export const sceneWordCount = (text: string): number => [...text.matchAll(NARRATION_WORD)].length;

/** Rig capabilities by rig id; a rig without a walk cycle would omit the walking actions. */
const RIG_ACTIONS: Readonly<Record<ExplainerCharacter["rigId"], readonly string[]>> = {
  "stick-v1": STICK_V1_ACTIONS,
};
/** Where entering and exiting actors start and end, just outside the 1080 px frame. */
export const OFFSTAGE_X = Object.freeze({ left: -220, right: 1300 });
/** Default walking speed and the fastest walk the rig's cycle still reads as walking. */
export const WALK_PX_PER_SEC = 520;
export const MAX_WALK_PX_PER_SEC = 900;
export const ACTION_DEFAULT_MS = Object.freeze({
  pose: 450,
  expression: 150,
  jump: 600,
  react: 900,
  point_at: 1_200,
  look_at: 1_200,
  emote: 1_800,
});
export const MIN_ACTION_MS = 200;
/** The shortest emote that still shows a start, a middle and an end. */
export const EMOTE_MIN_MS = 900;
export const MAX_ACTION_MS = 4_000;
export const MAX_ACTIONS_PER_ACTOR = 6;
export const MAX_ACTIONS_PER_SCENE = 10;
export const SCENE_END_TOLERANCE_MS = 500;
export const LOCOMOTION: readonly string[] = ["enter", "exit", "walk_to", "jump"];
/** Actions that drive the front arm or the whole body; a point_at cannot overlap any of them. */
export const ARM_BUSY: readonly string[] = ["point_at", "pose", ...LOCOMOTION];
const inRange = (index: number, length: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < length;
/** Whether what the action aims at is in this scene; an actor never aims at itself. */
const targetExists = (scene: SceneSpec, actor: SceneActor, action: ActorAction): boolean => {
  if (action.type !== "point_at" && action.type !== "look_at") return true;
  const { target } = action;
  if (target.kind === "actor")
    return (
      target.characterKey !== actor.characterKey &&
      scene.actors.some((other) => other.characterKey === target.characterKey)
    );
  return target.kind === "diagram"
    ? scene.diagram !== undefined
    : inRange(target.index, target.kind === "prop" ? scene.props.length : scene.overlays.length);
};
const overlaps = (a: TimedAction, b: TimedAction): boolean =>
  a.startMs < b.endMs && b.startMs < a.endMs;

/** Where a walking action ends, given the actor's stage position; undefined for other actions. */
export const walkTargetX = (
  action: ActorAction,
  homeX: number,
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): number | undefined =>
  action.type === "enter"
    ? homeX
    : action.type === "exit"
      ? geometry.offstageX[action.to]
      : action.type === "walk_to"
        ? positionX(action.to, geometry)
        : undefined;

/** The action's duration: explicit, or derived from walking distance or the defaults. */
export const actionDurationMs = (action: ActorAction, distancePx: number): number => {
  if ("durationMs" in action && action.durationMs !== undefined) return action.durationMs;
  if (action.type === "enter" || action.type === "exit" || action.type === "walk_to")
    return Math.max(400, Math.round((distancePx / WALK_PX_PER_SEC) * 1000));
  return ACTION_DEFAULT_MS[action.type];
};

type TimedAction = Readonly<{ action: ActorAction; startMs: number; endMs: number }>;

/**
 * Checks one actor's actions against its rig and the scene's estimated narration. Times are
 * estimated from the language's words-per-minute; the renderer re-times them from real words.
 */
const checkActions = (
  scene: SceneSpec,
  actor: SceneActor,
  rigActions: readonly string[],
  wordCount: number,
  msPerWord: number,
  declaredCount = (actor.actions ?? []).length,
): SceneSpecRejectionReason | null => {
  const actions = actor.actions ?? [];
  if (declaredCount > MAX_ACTIONS_PER_ACTOR) return "actions_limit";
  const sceneMs = wordCount * msPerWord;
  const homeX = positionX(actor.position);
  const sorted = [...actions].sort(
    (a, b) => a.atWord - b.atWord || (a.offsetMs ?? 0) - (b.offsetMs ?? 0),
  );
  const first = sorted[0];
  let x = first?.type === "enter" ? OFFSTAGE_X[first.from] : homeX;
  const timed: TimedAction[] = [];
  for (const action of sorted) {
    if (!rigActions.includes(action.type)) return "action_unsupported";
    if (action.type === "emote" && !EMOTIONS.includes(action.emotion)) return "action_unsupported";
    if (!Number.isInteger(action.atWord) || action.atWord < 0 || action.atWord >= wordCount)
      return "action_word_out_of_range";
    if (!targetExists(scene, actor, action)) return "action_target_missing";
    const targetX = walkTargetX(action, homeX);
    const distance = targetX === undefined ? 0 : Math.abs(targetX - x);
    const durationMs = actionDurationMs(action, distance);
    const explicit = "durationMs" in action && action.durationMs !== undefined;
    if (
      (explicit && (durationMs < MIN_ACTION_MS || durationMs > MAX_ACTION_MS)) ||
      distance / (durationMs / 1000) > MAX_WALK_PX_PER_SEC
    )
      return "action_duration_invalid";
    if (action.type === "emote" && durationMs < EMOTE_MIN_MS) return "action_duration_invalid";
    const startMs = action.atWord * msPerWord + (action.offsetMs ?? 0);
    const endMs = startMs + durationMs;
    if (endMs > sceneMs + SCENE_END_TOLERANCE_MS) return "action_exceeds_scene";
    if (targetX !== undefined) x = targetX;
    timed.push({ action, startMs, endMs });
  }
  const moves = timed.filter((entry) => LOCOMOTION.includes(entry.action.type));
  const poses = timed.filter((entry) => entry.action.type === "pose");
  const points = timed.filter((entry) => entry.action.type === "point_at");
  const looks = timed.filter((entry) => entry.action.type === "look_at");
  const emotes = timed.filter((entry) => entry.action.type === "emote");
  const exit = timed.find((entry) => entry.action.type === "exit");
  if (
    moves.some((entry, i) => i > 0 && entry.startMs < (moves[i - 1]?.endMs ?? 0)) ||
    poses.some((entry, i) => i > 0 && entry.action.atWord === poses[i - 1]?.action.atWord) ||
    moves.some((entry, i) => entry.action.type === "enter" && i > 0) ||
    (exit !== undefined &&
      timed.some((entry) => entry !== exit && entry.startMs >= exit.startMs)) ||
    points.some((point) =>
      timed.some(
        (other) =>
          other !== point && ARM_BUSY.includes(other.action.type) && overlaps(point, other),
      ),
    ) ||
    looks.some((look) => looks.some((other) => other !== look && overlaps(look, other))) ||
    // An emote drives pose, face, gaze and hops: nothing else of the same actor may overlap it.
    emotes.some((emote) => timed.some((other) => other !== emote && overlaps(emote, other)))
  )
    return "action_overlap";
  return null;
};

export type SceneSpecInput = {
  scenes: readonly SceneSpec[];
  characters: readonly ExplainerCharacter[];
  /** The script's claims; a number drawn in a diagram must cite a verified fact. */
  claims: readonly Readonly<{ kind: ClaimKind }>[];
  /** Which SceneSpec renderer will draw the scenes; only stickman_motion performs actions. */
  renderer?: "stickman_still" | "stickman_motion" | undefined;
  /** Script language and each scene's narration text, for anchoring and timing actions. */
  language?: string | undefined;
  sceneTexts?: readonly string[] | undefined;
};

/** One rejected rule, structured so a director model can fix every problem in one round. */
export type SceneSpecIssue = Readonly<{
  code: SceneSpecRejectionReason;
  sceneIndex?: number;
  field?: string;
  expected?: string;
  actual?: string;
  message: string;
}>;

const ISSUE_MESSAGES: Readonly<Record<SceneSpecRejectionReason, string>> = {
  purpose_sequence: "Fix the scene purposes",
  character_missing: "Use only characters from the cast",
  too_many_overlays: "Remove overlays",
  overlay_too_long: "Shorten or fill the overlay text",
  diagram_number_without_claim: "Remove the number from the diagram",
  repeated_scene: "Change the picture of this scene",
  overlay_ratio: "Remove overlays from some scenes",
  actors_limit: "Remove actors",
  props_limit: "Remove props",
  actions_require_motion: "Remove the actions",
  action_unsupported: "Use only actions the character supports",
  action_word_out_of_range: "Anchor every action to a word inside the scene",
  action_duration_invalid: "Fix the action durations",
  action_overlap: "Stop actions from overlapping",
  action_exceeds_scene: "End every action before the scene ends",
  actions_limit: "Remove actions",
  action_target_missing: "Aim the action at something present in the scene",
  camera_repeated: "Change the camera",
  background_asset_requires_motion: "Remove the background asset",
  token_unknown: "Use only known motion tokens",
  shot_capacity: "Match the actor count to the shot",
  shot_needs_prop: "Add a prop or change the shot",
  layout_actor_count: "Match the actor count to the layout",
  layout_actor_position: "Place actors on the layout slots",
  layout_needs_prop: "Add a prop required by the layout",
  layout_needs_diagram: "Add a diagram required by the layout",
  layout_overlay_position: "Move the overlay to an allowed position",
  dialogue_requires_motion: "Remove the dialogue",
  dialogue_coverage: "Make the dialogue lines cover the scene text in order",
  dialogue_speaker_missing: "Use only speakers that are actors of the scene",
  dialogue_speakers_limit: "Reduce the number of speakers",
  dialogue_narrator_interrupts: "Keep narrator lines out of the middle of a dialogue",
  dialogue_reaction_invalid: "Fix the dialogue reaction",
};

const shotExpectation = (shot: ShotKind): string => {
  const rule = SHOT_RULES[shot];
  const actors =
    rule.minActors === rule.maxActors
      ? `exactly ${rule.maxActors} actors`
      : `${rule.minActors}-${rule.maxActors} actors`;
  return `${shot} shot: ${actors}${rule.needsProp ? ", at least 1 prop" : ""}`;
};

/**
 * Every rule the scenes break, in the order validateSceneSpecs checks them, so its first
 * rejection is the first issue. Independent rules keep being checked after one fails; checks
 * that would only follow from an earlier failure of the same scene are skipped.
 */
export const collectSceneSpecIssues = (input: SceneSpecInput): readonly SceneSpecIssue[] => {
  const keys = new Set(input.characters.map((character) => character.key));
  const issues: SceneSpecIssue[] = [];
  const seen = new Set<string>();
  const add = (
    code: SceneSpecRejectionReason,
    sceneIndex: number,
    detail: Partial<Pick<SceneSpecIssue, "field" | "expected" | "actual">> = {},
  ): boolean => {
    const id = `${code}|${sceneIndex}|${detail.field ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    issues.push({ code, sceneIndex, ...detail, message: ISSUE_MESSAGES[code] });
    return true;
  };
  const first = input.scenes[0];
  if (first?.purpose !== "hook")
    add("purpose_sequence", 1, {
      field: "purpose",
      expected: "hook",
      actual: first?.purpose ?? "no scenes",
    });
  if (!input.scenes.some((scene) => scene.purpose === "payoff"))
    add("purpose_sequence", 1, {
      field: "purpose",
      expected: "at least one payoff scene",
      actual: "none",
    });
  let explanationRun = 0;
  const overlayIndexes: number[] = [];
  let previous: string | null = null;
  let previousCamera: string | null = null;
  for (const scene of input.scenes) {
    const at = scene.index;
    explanationRun = scene.purpose === "explanation" ? explanationRun + 1 : 0;
    if (explanationRun === MAX_EXPLANATION_RUN + 1)
      add("purpose_sequence", at, {
        field: "purpose",
        expected: `at most ${MAX_EXPLANATION_RUN} explanation scenes in a row`,
        actual: `scene ${at} is the ${explanationRun}th`,
      });
    const tooManyActors = scene.actors.length > MAX_ACTORS;
    if (tooManyActors)
      add("actors_limit", at, {
        field: "actors",
        expected: `at most ${MAX_ACTORS}`,
        actual: String(scene.actors.length),
      });
    if (scene.props.length > MAX_PROPS)
      add("props_limit", at, {
        field: "props",
        expected: `at most ${MAX_PROPS}`,
        actual: String(scene.props.length),
      });
    if (scene.overlays.length > MAX_OVERLAYS)
      add("too_many_overlays", at, {
        field: "overlays",
        expected: `at most ${MAX_OVERLAYS}`,
        actual: String(scene.overlays.length),
      });
    for (const [i, overlay] of scene.overlays.entries())
      if (overlay.text.trim().length === 0 || overlay.text.length > MAX_OVERLAY_CHARS)
        add("overlay_too_long", at, {
          field: `overlays[${i}].text`,
          expected: `1-${MAX_OVERLAY_CHARS} characters`,
          actual: String(overlay.text.trim().length === 0 ? 0 : overlay.text.length),
        });
    const unknownCast = scene.actors.flatMap((actor, i) =>
      keys.has(actor.characterKey) ? [] : [{ actor, i }],
    );
    for (const { actor, i } of unknownCast)
      add("character_missing", at, {
        field: `actors[${i}].characterKey`,
        expected: `one of ${[...keys].join(", ")}`,
        actual: actor.characterKey,
      });
    if (scene.backgroundAssetId !== undefined && input.renderer !== "stickman_motion")
      add("background_asset_requires_motion", at, {
        field: "backgroundAssetId",
      });
    // v2 slice 23: shot kinds and layouts carry rules; today's three shots never trip them.
    const shotRule = shotRuleViolation(scene);
    if (shotRule && !(tooManyActors && shotRule === "shot_capacity"))
      add(shotRule, at, {
        field: "camera",
        expected: shotExpectation(scene.camera.shot),
        actual: `${scene.actors.length} actors, ${scene.props.length} props`,
      });
    const layout = sceneLayoutMismatch(scene);
    if (layout && !(tooManyActors && layout === "layout_actor_count"))
      add(layout, at, {
        field: "layoutId",
        expected: `scene fits layout ${scene.layoutId}`,
        actual: layout,
      });
    // Unknown cast makes dialogue speakers and actions meaningless; fix the cast first.
    if (unknownCast.length === 0) {
      if (scene.dialogue?.length) {
        if (input.renderer !== "stickman_motion")
          add("dialogue_requires_motion", at, { field: "dialogue" });
        else {
          const dialogue = checkDialogue({
            lines: scene.dialogue,
            scene,
            sceneText: input.sceneTexts?.[at - 1] ?? "",
            // Reactions carry no target, so only target-free tokens can react.
            knownTokens: (token) =>
              isKnownToken({ token }) && !MOTION_TOKENS[token as MotionTokenId].requiresTarget,
          });
          if (dialogue) add(dialogue, at, { field: "dialogue" });
        }
      }
      // A motion token counts as one action against the limits (v2 slice 22); dialogue reactions
      // (v2 slice 32) are tokens on the listener and count the same way.
      const reactions = scene.dialogue?.length
        ? dialogueReactionTokens(scene.dialogue, input.sceneTexts?.[at - 1] ?? "", scene.fromChar)
        : undefined;
      const actorsWithReactions = scene.actors.map((actor) => {
        const extra = reactions?.get(actor.characterKey);
        return extra
          ? {
              ...actor,
              motionTokens: [...(actor.motionTokens ?? []), ...extra],
            }
          : actor;
      });
      const actionCount = actorsWithReactions.reduce(
        (sum, actor) => sum + (actor.actions?.length ?? 0) + (actor.motionTokens?.length ?? 0),
        0,
      );
      if (actionCount > 0) {
        if (input.renderer !== "stickman_motion")
          add("actions_require_motion", at, { field: "actors[].actions" });
        else {
          const sceneLimit = actionCount > MAX_ACTIONS_PER_SCENE;
          if (sceneLimit)
            add("actions_limit", at, {
              field: "actors",
              expected: `at most ${MAX_ACTIONS_PER_SCENE} actions in the scene`,
              actual: String(actionCount),
            });
          const wordCount = sceneWordCount(input.sceneTexts?.[at - 1] ?? "");
          const msPerWord = narrationMsPerWord(input.language ?? "en");
          for (const [i, actor] of actorsWithReactions.entries()) {
            const character = input.characters.find((entry) => entry.key === actor.characterKey);
            let tokenIssue = false;
            for (const token of actor.motionTokens ?? []) {
              if (!isKnownToken(token)) {
                tokenIssue =
                  add("token_unknown", at, {
                    field: `actors[${i}].motionTokens`,
                  }) || tokenIssue;
                continue;
              }
              const needs = MOTION_TOKENS[token.token].requiresTarget;
              if (
                (needs && !token.target) ||
                (token.target &&
                  !targetExists(scene, actor, {
                    type: "point_at",
                    atWord: 0,
                    target: token.target,
                  }))
              )
                tokenIssue =
                  add("action_target_missing", at, {
                    field: `actors[${i}].motionTokens`,
                  }) || tokenIssue;
            }
            if (tokenIssue) continue;
            const reason = checkActions(
              scene,
              withExpandedTokens(actor),
              character ? RIG_ACTIONS[character.rigId] : [],
              wordCount,
              msPerWord,
              (actor.actions?.length ?? 0) + (actor.motionTokens?.length ?? 0),
            );
            if (reason && !(sceneLimit && reason === "actions_limit"))
              add(reason, at, {
                field: `actors[${i}].actions`,
                ...(reason === "actions_limit"
                  ? { expected: `at most ${MAX_ACTIONS_PER_ACTOR}` }
                  : {}),
              });
          }
        }
      }
    }
    if (
      scene.diagram &&
      diagramNumericRefs(scene.diagram).some(
        (ref) => ref === undefined || input.claims[ref]?.kind !== "verified_fact",
      )
    )
      add("diagram_number_without_claim", at, { field: "diagram" });
    const current = sceneSignature(scene);
    if (current === previous)
      add("repeated_scene", at, {
        field: "background",
        expected: `differs from scene ${at - 1}`,
        actual: "same background, actors, props and diagram",
      });
    previous = current;
    // Direction rule: a new scene is a new picture; still renderers draw several moves alike.
    const camera = `${scene.camera.shot}:${scene.camera.movement}`;
    if (input.renderer === "stickman_motion" && camera === previousCamera)
      add("camera_repeated", at, {
        field: "camera",
        expected: `differs from scene ${at - 1}`,
        actual: camera,
      });
    previousCamera = camera;
    if (scene.overlays.length > 0) overlayIndexes.push(at);
  }
  const maxOverlayScenes = Math.ceil(input.scenes.length * MAX_OVERLAY_SHARE);
  if (overlayIndexes.length > maxOverlayScenes)
    add("overlay_ratio", input.scenes.length, {
      field: "overlays",
      expected: `at most ${maxOverlayScenes} scenes with overlays`,
      actual: `${overlayIndexes.length} (scenes ${overlayIndexes.join(", ")})`,
    });
  return issues;
};

export const validateSceneSpecs = (input: SceneSpecInput): SceneSpecVerdict => {
  const issue = collectSceneSpecIssues(input)[0];
  return issue
    ? {
        ok: false,
        rejection: { index: issue.sceneIndex ?? 1, reason: issue.code },
      }
    : { ok: true };
};

/** Longest estimated narration a scene may hold with no cut and no action starting. */
const STATIC_STRETCH_MS = 6_000;
/** Advisory direction findings, "<reason>:<scene index>"; they never block a storyboard. */
export type SceneSpecWarning = `static_stretch:${number}` | MotionBudgetWarning;

/**
 * Direction warnings, never rejections. static_stretch: some stretch of a scene's estimated
 * narration, from the cut or from an action starting to the next start or the scene's end, runs
 * past 6 s. The fix is a cut (split the scene) or an action.
 */
export const sceneSpecWarnings = (input: {
  scenes: readonly SceneSpec[];
  language: string;
  sceneTexts: readonly string[];
}): readonly SceneSpecWarning[] => {
  const msPerWord = narrationMsPerWord(input.language);
  const stretch = input.scenes.flatMap((scene): SceneSpecWarning[] => {
    const sceneMs = sceneWordCount(input.sceneTexts[scene.index - 1] ?? "") * msPerWord;
    const starts = scene.actors
      .flatMap((actor) => actor.actions ?? [])
      .map((action) => action.atWord * msPerWord)
      .sort((a, b) => a - b);
    let longest = 0;
    let last = 0;
    for (const at of [...starts, sceneMs]) {
      longest = Math.max(longest, at - last);
      last = at;
    }
    return longest > STATIC_STRETCH_MS ? [`static_stretch:${scene.index}`] : [];
  });
  // v2 slice 16: motion budget and cadence, after the stretch check, same shape. A stretch
  // already says the scene is static, so the cadence gap is not repeated for it.
  const stretched = new Set(stretch.map((warning) => warning.split(":")[1]));
  return [
    ...stretch,
    ...motionBudgetWarnings(input).filter(
      (warning) => !(warning.startsWith("cadence_gap:") && stretched.has(warning.split(":")[1])),
    ),
  ];
};

export const sceneMotion = (camera: SceneCamera): SceneMotion =>
  camera.movement === "slow_zoom_in" || camera.movement === "push_in"
    ? "ken_burns_in"
    : camera.movement === "slow_zoom_out"
      ? "ken_burns_out"
      : camera.movement === "pan_left" || camera.movement === "pan_right"
        ? camera.movement
        : "static";

export const sceneChecksum = (scene: SceneSpec): string =>
  createHash("sha256").update(canonicalJson(scene), "utf8").digest("hex");
