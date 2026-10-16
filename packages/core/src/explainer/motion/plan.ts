import { gapsBetween, type TimeRange } from "../../publishing/render-quality.js";
import { actorScaleFor, propAnchor } from "../compose-scene.js";
import { type BackgroundArt, type LineStyle, plateBox } from "../background-art.js";
import type { CompositingProfile } from "../compositing.js";
import type { Location } from "../locations.js";
import { dialogueReactionTokens, lineWordRanges } from "../dialogue.js";
import { type SceneMotionToken, withExpandedTokens } from "../motion-tokens.js";
import { grammarFromProfile, type VisualLanguageProfile } from "../visual-language.js";
import { GRAMMAR } from "./tuning.js";
import { diagramSteps } from "../diagrams.js";
import type { ExplainerCharacter, ScenePalette } from "../explainer-context.js";
import {
  type Canvas,
  type CanvasGeometry,
  geometryFor,
  PORTRAIT_GEOMETRY,
  positionX,
} from "../layout.js";
import { type ExpressionId, HEAD_Y, type PoseId } from "../rigs/stick-v1.js";
import {
  ACTION_DEFAULT_MS,
  type ActorAction,
  actionDurationMs,
  EMOTE_MIN_MS,
  type Emotion,
  type LookTarget,
  type SceneActor,
  type SceneOverlay,
  NARRATION_WORD,
  type SceneSpec,
  walkTargetX,
} from "../scene-spec.js";

/**
 * Motion plan: every time-dependent decision for a stickman_motion render, made once from the
 * scenes and the measured narration. Frames (frame.ts) are then a pure function of (plan, t).
 */
export type MotionWord = Readonly<{ text: string; startMs: number; endMs: number }>;
/** One scene on the final timeline: when it is on screen and when its narration plays. */
export type MotionSceneTiming = Readonly<{
  startMs: number;
  endMs: number;
  voiceStartMs: number;
  voiceEndMs: number;
  /** Spoken words on the final timeline (absolute ms), as the TTS returned them. */
  words: readonly MotionWord[];
  /** The scene's slice of the script. */
  text: string;
}>;
export type SfxId = "pop" | "whoosh" | "ding" | "thud" | "tick";
export type SfxCue = Readonly<{ id: SfxId; atMs: number }>;
/** A glance an emote derives: it aims at a stage point (ResolvedAction.target), not a scene target. */
export type DerivedGlance = Readonly<{
  type: "look_at";
  atWord: number;
  target: Readonly<{ kind: "stage" }>;
}>;
export type ResolvedAction = Readonly<{
  /** The actor's own action, or a primitive the planner derived from an emote. */
  action: ActorAction | DerivedGlance;
  startMs: number;
  endMs: number;
  /** Walking actions: where the actor starts and ends, px. */
  fromX: number;
  toX: number;
  /** point_at, look_at and emote glances: the stage point aimed at, px. */
  target?: Readonly<{ x: number; y: number }>;
  /** Emote pose steps: degrees added to the named pose's lean. */
  lean?: number;
}>;
/** Idle motion of one actor in one scene: breathing cycle and blink times, seeded, never random. */
export type IdlePlan = Readonly<{
  breathPeriodMs: number;
  /** Where the breathing cycle starts, 0..1. */
  breathPhase: number;
  /** Absolute times the eyes start to close. */
  blinksAtMs: readonly number[];
}>;
export type PlannedActor = Readonly<{
  actor: SceneActor;
  character: ExplainerCharacter;
  /** The narrator lip-syncs; only the first main character in the scene. */
  narrator: boolean;
  actions: readonly ResolvedAction[];
  /** Breathing and blinks while the actor is idle; seeded by scene index and character key. */
  idle: IdlePlan;
}>;
export type CaptionGroup = Readonly<{
  words: readonly MotionWord[];
  startMs: number;
  endMs: number;
}>;
export type PlannedScene = Readonly<{
  spec: SceneSpec;
  startMs: number;
  endMs: number;
  voiceStartMs: number;
  voiceEndMs: number;
  words: readonly MotionWord[];
  actors: readonly PlannedActor[];
  overlays: readonly Readonly<{ overlay: SceneOverlay; atMs: number }>[];
  propsAtMs: readonly number[];
  diagram?: Readonly<{ startMs: number; endMs: number }>;
  /** A painted background drawn instead of the procedural one. */
  art?: BackgroundArt;
  /**
   * Location plate framing (v2 slice 24): the overscan box the art fills, the zone crop after
   * seeded variation, and the lighting tint. Absent draws the art as before.
   */
  plate?: PlateFraming;
  /** Dialogue (slice 32): each on-screen speaker's words; absent means the narrator speaks. */
  speakers?: readonly Readonly<{ characterKey: string; words: readonly MotionWord[] }>[];
  captions: readonly CaptionGroup[];
  /** Reaction marks from actions and from the scene purpose (surprise, payoff). */
  marks: readonly Readonly<{
    characterKey: string;
    mark: "exclaim" | "sparkle";
    atMs: number;
  }>[];
}>;
export type MotionPlan = Readonly<{
  /** Canvas geometry the plan is composed for; absent means portrait (1080x1920). */
  canvas?: Canvas | undefined;
  durationMs: number;
  fps: 30;
  palette: ScenePalette;
  lineStyle: LineStyle;
  /** Niche compositing profile (v2 slice 14); absent draws exactly today's frames. */
  compositing?: CompositingProfile | undefined;
  /** Motion grammar (v2 slice 15): anticipation, overshoot, settle, arcs, moving holds. */
  motionGrammar?: boolean | undefined;
  /** Grammar numbers: the niche profile's, else GRAMMAR (slice 18). */
  grammar?: typeof GRAMMAR | undefined;
  /** Niche visual language (v2 slice 18); absent keeps today's constants. */
  visualLanguage?: VisualLanguageProfile | undefined;
  scenes: readonly PlannedScene[];
  sfx: readonly SfxCue[];
  plannedSilence: readonly TimeRange[];
  plannedDark: readonly TimeRange[];
  notes: readonly string[];
}>;

export const TRANSITION_MS = 300;
const PROP_FIRST_MS = 200;
const PROP_STAGGER_MS = 120;
const DIAGRAM_START_MS = 300;
const DIAGRAM_SHARE = 0.7;
const OVERLAY_FALLBACK_SHARE = 0.2;
const MIN_ACTION_MS = 200;
const CAPTION_TAIL_MS = 250;
const MARK_MS = 900;

const TOKEN = NARRATION_WORD;
const normalize = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const hash = (text: string) =>
  [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 997, 7);

const BLINK_FIRST_MS = 400;
const BLINK_FIRST_SPREAD_MS = 1_100;
const BLINK_GAP_MS = 2_200;
const BLINK_GAP_SPREAD_MS = 2_400;
const DOUBLE_BLINK_MS = 220;
const DOUBLE_BLINK_CHANCE = 0.15;

/** mulberry32: a tiny seeded generator, so the same scene idles the same on every render. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const planIdle = (
  sceneIndex: number,
  characterKey: string,
  startMs: number,
  endMs: number,
): IdlePlan => {
  const random = seeded(sceneIndex * 7_919 + hash(characterKey));
  const breathPeriodMs = 2_600 + Math.round(random() * 800);
  const breathPhase = random();
  const blinksAtMs: number[] = [];
  for (
    let at = startMs + BLINK_FIRST_MS + Math.round(random() * BLINK_FIRST_SPREAD_MS);
    at < endMs;
    at += BLINK_GAP_MS + Math.round(random() * BLINK_GAP_SPREAD_MS)
  ) {
    blinksAtMs.push(at);
    if (random() < DOUBLE_BLINK_CHANCE && at + DOUBLE_BLINK_MS < endMs)
      blinksAtMs.push(at + DOUBLE_BLINK_MS);
  }
  return { breathPeriodMs, breathPhase, blinksAtMs };
};

type Anchor = Readonly<{ startMs: number; sentenceEnd: boolean }>;

/**
 * One anchor per text token: its spoken start (exact when the TTS words match the text token for
 * token, proportional across the clip otherwise) and whether a sentence ends after it.
 */
const anchorsFor = (timing: MotionSceneTiming): Readonly<{ anchors: Anchor[]; exact: boolean }> => {
  const tokens = [...timing.text.matchAll(TOKEN)];
  const spoken = timing.words.filter((word) => normalize(word.text).length > 0);
  const exact =
    spoken.length === tokens.length &&
    tokens.every((token, i) => normalize(token[0]) === normalize(spoken[i]?.text ?? ""));
  const span = timing.voiceEndMs - timing.voiceStartMs;
  const anchors = tokens.map((token, i) => {
    const next = tokens[i + 1];
    const between = timing.text.slice(
      (token.index ?? 0) + token[0].length,
      next ? (next.index ?? 0) : undefined,
    );
    return {
      startMs: exact
        ? (spoken[i]?.startMs ?? timing.voiceStartMs)
        : Math.round(timing.voiceStartMs + (i / Math.max(1, tokens.length)) * span),
      sentenceEnd: /[.?!…]/.test(between),
    };
  });
  return { anchors, exact };
};

const captionGroups = (
  words: readonly MotionWord[],
  sentenceEnds: readonly boolean[],
  maxWords: number,
  sceneEndMs: number,
): CaptionGroup[] => {
  const groups: MotionWord[][] = [];
  let current: MotionWord[] = [];
  words.forEach((word, i) => {
    current.push(word);
    if (current.length >= maxWords || sentenceEnds[i] || /[.?!…]$/.test(word.text)) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);
  return groups.map((group, i) => {
    const next = groups[i + 1]?.[0];
    const last = group.at(-1);
    return {
      words: group,
      startMs: group[0]?.startMs ?? 0,
      endMs: Math.min(sceneEndMs, next ? next.startMs : (last?.endMs ?? 0) + CAPTION_TAIL_MS),
    };
  });
};

/** Where an action target sits on the stage, px; undefined when the scene has no such target. */
export const actionTargetPoint = (
  spec: SceneSpec,
  target: LookTarget,
  geo: CanvasGeometry = PORTRAIT_GEOMETRY,
): Readonly<{ x: number; y: number }> | undefined => {
  if (target.kind === "actor") {
    const other = spec.actors.find((entry) => entry.characterKey === target.characterKey);
    // ponytail: aims at the other actor's stage position, not where its own walk has taken it;
    // follow its resolved walk if a look at a walking actor reads wrong on review.
    return other
      ? {
          x: positionX(other.position, geo),
          y: geo.baselineY + HEAD_Y * actorScaleFor(spec, other),
        }
      : undefined;
  }
  if (target.kind === "diagram")
    return spec.diagram
      ? {
          x: geo.diagramRect.x + geo.diagramRect.width / 2,
          y: geo.diagramRect.y + geo.diagramRect.height / 2,
        }
      : undefined;
  if (target.kind === "prop") {
    const prop = spec.props[target.index];
    return prop ? propAnchor(prop, geo) : undefined;
  }
  const overlay = spec.overlays[target.index];
  return overlay ? { x: geo.frame.width / 2, y: geo.overlayY[overlay.position] } : undefined;
};

/** One emote step, as shares of the emote's duration: when it starts and when it has settled. */
type EmoteStep = Readonly<
  | { kind: "pose"; at: number; until: number; pose: PoseId; lean?: number }
  | { kind: "expression"; at: number; expression: ExpressionId }
  | { kind: "hop"; at: number; until: number }
  | { kind: "glance"; at: number; until: number; side: -1 | 1 }
>;
/** Start and middle of each emotion; emoteSteps appends the same end to every recipe. */
const EMOTES: Readonly<Record<Emotion, readonly EmoteStep[]>> = {
  // Arms thrown out and back, then a forward slump.
  frustrated: [
    { kind: "expression", at: 0, expression: "angry" },
    { kind: "pose", at: 0, until: 0.25, pose: "confused", lean: -6 },
    { kind: "pose", at: 0.35, until: 0.6, pose: "confused", lean: 12 },
  ],
  // Arms up, two quick hops.
  excited: [
    { kind: "expression", at: 0, expression: "excited" },
    { kind: "pose", at: 0, until: 0.2, pose: "surprised" },
    { kind: "hop", at: 0.25, until: 0.45 },
    { kind: "hop", at: 0.5, until: 0.7 },
  ],
  // Hand to chin, a look to each side.
  searching: [
    { kind: "expression", at: 0, expression: "confused" },
    { kind: "pose", at: 0, until: 0.2, pose: "thinking" },
    { kind: "glance", at: 0.2, until: 0.48, side: -1 },
    { kind: "glance", at: 0.5, until: 0.78, side: 1 },
  ],
  // Shrinks back, one nervous look away.
  worried: [
    { kind: "expression", at: 0, expression: "worried" },
    { kind: "pose", at: 0, until: 0.3, pose: "scared", lean: -5 },
    { kind: "glance", at: 0.3, until: 0.7, side: -1 },
  ],
  // Arms up, chest out, one big hop.
  triumphant: [
    { kind: "expression", at: 0, expression: "happy" },
    { kind: "pose", at: 0, until: 0.25, pose: "celebrating", lean: -6 },
    { kind: "hop", at: 0.3, until: 0.65 },
  ],
};
/** The end of every emote: back to the pose, then the face, it had before. */
const EMOTE_RETURN_AT = 0.75;
const EMOTE_FACE_RETURN_AT = 0.9;
const GLANCE_PX = 400;

/** An emote's primitives, in time order, all inside [startMs, endMs]. */
const emoteSteps = (
  action: Extract<ActorAction, { type: "emote" }>,
  startMs: number,
  endMs: number,
  before: Readonly<{ x: number; headY: number; pose: PoseId; expression: ExpressionId }>,
): ResolvedAction[] => {
  const at = (share: number) => startMs + Math.round((endMs - startMs) * share);
  const { atWord } = action;
  const inPlace = { fromX: before.x, toX: before.x };
  const steps: readonly EmoteStep[] = [
    ...EMOTES[action.emotion],
    { kind: "pose", at: EMOTE_RETURN_AT, until: 1, pose: before.pose },
    { kind: "expression", at: EMOTE_FACE_RETURN_AT, expression: before.expression },
  ];
  return steps.map((step): ResolvedAction => {
    if (step.kind === "expression")
      return {
        action: { type: "expression", atWord, expression: step.expression },
        startMs: at(step.at),
        endMs: Math.min(endMs, at(step.at) + ACTION_DEFAULT_MS.expression),
        ...inPlace,
      };
    const span = { startMs: at(step.at), endMs: at(step.until), ...inPlace };
    if (step.kind === "pose")
      return {
        action: { type: "pose", atWord, pose: step.pose },
        ...span,
        ...(step.lean ? { lean: step.lean } : {}),
      };
    if (step.kind === "hop") return { action: { type: "jump", atWord }, ...span };
    return {
      action: { type: "look_at", atWord, target: { kind: "stage" } },
      ...span,
      target: { x: before.x + step.side * GLANCE_PX, y: before.headY },
    };
  });
};

const resolveActions = (
  spec: SceneSpec,
  actor: SceneActor,
  anchors: readonly Anchor[],
  sceneEndMs: number,
  onDrop: () => void,
  geo: CanvasGeometry,
): ResolvedAction[] => {
  const homeX = positionX(actor.position, geo);
  const sorted = [...(withExpandedTokens(actor).actions ?? [])].sort(
    (a, b) => a.atWord - b.atWord || (a.offsetMs ?? 0) - (b.offsetMs ?? 0),
  );
  const first = sorted[0];
  let x = first?.type === "enter" ? geo.offstageX[first.from] : homeX;
  let locomotionFreeAt = 0;
  const resolved: ResolvedAction[] = [];
  let pose: PoseId = actor.pose;
  let expression: ExpressionId = actor.expression;
  const headY = geo.baselineY + HEAD_Y * actorScaleFor(spec, actor);
  for (const action of sorted) {
    const targetX = walkTargetX(action, homeX, geo);
    // An emote hops and drives the whole body, so it queues behind walks like a jump.
    const moves = targetX !== undefined || action.type === "jump" || action.type === "emote";
    const anchor =
      (anchors[action.atWord]?.startMs ?? anchors.at(-1)?.startMs ?? 0) + (action.offsetMs ?? 0);
    // Real narration can bunch words closer than the estimate validation used.
    const startMs = moves ? Math.max(anchor, locomotionFreeAt) : anchor;
    const wanted = actionDurationMs(action, targetX === undefined ? 0 : Math.abs(targetX - x));
    const endMs = Math.min(startMs + wanted, sceneEndMs);
    // An expression change (150 ms) is shorter than the compression floor and still fits.
    const floorMs = action.type === "emote" ? EMOTE_MIN_MS : MIN_ACTION_MS;
    // Stored JSON can bypass validation: an unknown emotion has no recipe and is dropped.
    const unknownEmote = action.type === "emote" && !EMOTES[action.emotion];
    if (unknownEmote || endMs - startMs < Math.min(wanted, floorMs)) {
      onDrop();
      continue;
    }
    const target = "target" in action ? actionTargetPoint(spec, action.target, geo) : undefined;
    // A target missing at render time (validation bypassed) keeps the previous pose.
    if ("target" in action && target === undefined) {
      onDrop();
      continue;
    }
    resolved.push({
      action,
      startMs,
      endMs,
      fromX: x,
      toX: targetX ?? x,
      ...(target ? { target } : {}),
    });
    if (action.type === "emote")
      resolved.push(...emoteSteps(action, startMs, endMs, { x, headY, pose, expression }));
    if (action.type === "pose") pose = action.pose;
    if (action.type === "expression") expression = action.expression;
    if (targetX !== undefined) x = targetX;
    if (moves) locomotionFreeAt = endMs;
  }
  return resolved;
};

const NEUTRAL_REACTION_MS = 250;
/** Shifts react actions by `deltaMs`, kept inside the scene; other actions are untouched. */
const delayReactions = (
  actions: readonly ResolvedAction[],
  deltaMs: number,
  sceneStartMs: number,
  sceneEndMs: number,
): readonly ResolvedAction[] =>
  deltaMs === 0
    ? actions
    : actions.map((resolved) => {
        if (resolved.action.type !== "react") return resolved;
        const span = resolved.endMs - resolved.startMs;
        const startMs = Math.max(
          sceneStartMs,
          Math.min(resolved.startMs + deltaMs, sceneEndMs - span),
        );
        return { ...resolved, startMs: Math.round(startMs), endMs: Math.round(startMs + span) };
      });

export type PlateFraming = Readonly<{
  box: Readonly<{ x: number; y: number; width: number; height: number }>;
  /** Crop centre as box fractions, and zoom. */
  cx: number;
  cy: number;
  zoom: number;
  grade?: Readonly<{ tint: string; alpha: number }> | undefined;
}>;
const hash01 = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};
/** Visible margin the far layer needs beyond the frame (camera zoom, pans, shakes). */
const PLATE_MARGIN = 1.12;

/**
 * Zone crop, seeded variation (offset ±6%, zoom 1.0-1.15, spec 12) and lighting tint of a
 * location scene, with the crop clamped so the plate always covers the frame.
 */
const plateFraming = (
  spec: SceneSpec,
  locations: readonly Location[] | undefined,
  seed: string | undefined,
  geo: CanvasGeometry,
): PlateFraming | undefined => {
  const location = spec.locationId ? locations?.find((l) => l.id === spec.locationId) : undefined;
  if (!location) return undefined;
  const zone = location.zones.find((z) => z.id === spec.zoneId);
  const box = plateBox(location.plate.overscan, geo);
  const key = `${seed ?? ""}:${location.id}:${zone?.id ?? ""}:${spec.index}`;
  const zoom = (zone?.crop.zoom ?? 1) * (1 + 0.15 * hash01(`${key}:z`));
  const halfW = Math.min(0.5, (geo.frame.width / 2 / (box.width * zoom)) * PLATE_MARGIN);
  const halfH = Math.min(0.5, (geo.frame.height / 2 / (box.height * zoom)) * PLATE_MARGIN);
  const cx = Math.min(
    1 - halfW,
    Math.max(halfW, (zone?.crop.cx ?? 0.5) + (hash01(`${key}:x`) - 0.5) * 0.12),
  );
  const cy = Math.min(
    1 - halfH,
    Math.max(halfH, (zone?.crop.cy ?? 0.5) + (hash01(`${key}:y`) - 0.5) * 0.12),
  );
  const grade = spec.lighting ? location.lighting?.[spec.lighting] : undefined;
  return {
    box,
    cx: Math.round(cx * 1000) / 1000,
    cy: Math.round(cy * 1000) / 1000,
    zoom: Math.round(zoom * 1000) / 1000,
    ...(grade ? { grade: { tint: grade.tint, alpha: grade.tintAlpha } } : {}),
  };
};

/**
 * Longest stretch of a scene in which nothing moves (motion grammar): actors always move (moving
 * holds), so only scenes without actors and without a camera move can go dead; prop pops,
 * overlay slams, marks and a drawing diagram count as motion. Intentional stills are exempt.
 */
const deadFrameMs = (scene: PlannedScene): number => {
  if (scene.spec.holdMode === "intentional_still") return 0;
  if (scene.actors.length > 0 || scene.spec.camera.movement !== "none") return 0;
  const busy: { startMs: number; endMs: number }[] = [
    ...scene.propsAtMs.map((at) => ({ startMs: at, endMs: at + 400 })),
    ...scene.overlays.map((entry) => ({ startMs: entry.atMs, endMs: entry.atMs + 500 })),
    ...scene.marks.map((mark) => ({ startMs: mark.atMs, endMs: mark.atMs + 900 })),
    ...(scene.diagram ? [scene.diagram] : []),
  ].sort((a, b) => a.startMs - b.startMs);
  let cursor = scene.startMs;
  let longest = 0;
  for (const range of busy) {
    longest = Math.max(longest, range.startMs - cursor);
    cursor = Math.max(cursor, range.endMs);
  }
  return Math.max(longest, scene.endMs - cursor);
};

export const planMotion = (input: {
  scenes: readonly SceneSpec[];
  timings: readonly MotionSceneTiming[];
  characters: readonly ExplainerCharacter[];
  palette: ScenePalette;
  captionWords: 2 | 3 | 4;
  durationMs: number;
  /** Painted backgrounds by asset id; a scene whose asset is absent draws its procedural setting. */
  backgroundArt?: ReadonlyMap<string, BackgroundArt> | undefined;
  lineStyle?: LineStyle | undefined;
  compositing?: CompositingProfile | undefined;
  /** Default false: the grammar changes every frame, so it is opt-in per niche. */
  motionGrammar?: boolean | undefined;
  visualLanguage?: VisualLanguageProfile | undefined;
  /** Niche locations (v2 slice 24): zone crops and lighting grades for location scenes. */
  locations?: readonly Location[] | undefined;
  /** Per-storyboard seed for plate variation (crop offset, zoom); same seed, same frames. */
  variationSeed?: string | undefined;
  /** Absent means portrait; landscape is 1920x1080 with its own stage and caption band. */
  canvas?: Canvas | undefined;
}): MotionPlan => {
  const geo = geometryFor(input.canvas);
  if (input.scenes.length !== input.timings.length) throw new Error("motion_timing_mismatch");
  const byKey = new Map(input.characters.map((character) => [character.key, character]));
  const notes: string[] = [];
  const sfx: SfxCue[] = [];
  const scenes = input.scenes.map((spec, position): PlannedScene => {
    const timing = input.timings[position] as MotionSceneTiming;
    const { anchors, exact } = anchorsFor(timing);
    const hasActions = spec.actors.some(
      (actor) => (actor.actions?.length ?? 0) + (actor.motionTokens?.length ?? 0) > 0,
    );
    if (hasActions && !exact) notes.push(`action_timing_estimated:${spec.index}`);
    let dropped = false;
    const narratorKey = spec.actors.find(
      (actor) => byKey.get(actor.characterKey)?.role === "main",
    )?.characterKey;
    // Dialogue (slice 32): listener reactions become motion tokens on the reacting actor.
    const lineRanges = spec.dialogue?.length
      ? lineWordRanges(timing.text, spec.fromChar, spec.dialogue)
      : [];
    const reactionTokens = spec.dialogue?.length
      ? dialogueReactionTokens(spec.dialogue, timing.text, spec.fromChar)
      : new Map<string, readonly SceneMotionToken[]>();
    const actors = spec.actors.map((sceneActor): PlannedActor => {
      const reactions = reactionTokens.get(sceneActor.characterKey);
      const actor = reactions
        ? { ...sceneActor, motionTokens: [...(sceneActor.motionTokens ?? []), ...reactions] }
        : sceneActor;
      const character = byKey.get(actor.characterKey);
      if (!character) throw new Error(`scene_character_missing:${spec.index}`);
      return {
        actor,
        character,
        narrator: actor.characterKey === narratorKey,
        actions: delayReactions(
          resolveActions(
            spec,
            actor,
            anchors,
            timing.endMs,
            () => {
              dropped = true;
            },
            geo,
          ),
          // Acting (v2 slice 20): a listener's reactions land after its reaction delay; the
          // neutral 250 ms is today's timing. Grammar on only; the narrator is never delayed.
          input.motionGrammar && actor.characterKey !== narratorKey
            ? (character.bible?.acting?.reactionDelayMs ?? NEUTRAL_REACTION_MS) -
                NEUTRAL_REACTION_MS
            : 0,
          timing.startMs,
          timing.endMs,
        ),
        idle: planIdle(spec.index, character.key, timing.startMs, timing.endMs),
      };
    });
    if (dropped) notes.push(`action_dropped:${spec.index}`);
    const art =
      spec.backgroundAssetId === undefined
        ? undefined
        : input.backgroundArt?.get(spec.backgroundAssetId);
    if (spec.backgroundAssetId !== undefined && !art)
      notes.push(`background_fallback:${spec.index}`);
    const words = exact
      ? timing.words.filter((word) => normalize(word.text).length > 0)
      : [...timing.text.matchAll(TOKEN)].map((token, i, all) => ({
          text: token[0],
          startMs: anchors[i]?.startMs ?? timing.voiceStartMs,
          endMs: anchors[i + 1]?.startMs ?? (i === all.length - 1 ? timing.voiceEndMs : 0),
        }));
    const duration = timing.endMs - timing.startMs;
    const tokens = [...timing.text.matchAll(TOKEN)].map((token) => normalize(token[0]));
    const overlays = spec.overlays.map((overlay) => {
      const first = normalize(overlay.text.match(TOKEN)?.[0] ?? "");
      const at = tokens.indexOf(first);
      return {
        overlay,
        atMs:
          at >= 0
            ? (anchors[at]?.startMs ?? timing.voiceStartMs)
            : Math.round(timing.startMs + duration * OVERLAY_FALLBACK_SHARE),
      };
    });
    const propsAtMs = spec.props.map(
      (_prop, i) => timing.startMs + PROP_FIRST_MS + i * PROP_STAGGER_MS,
    );
    const diagram = spec.diagram
      ? {
          startMs: timing.startMs + DIAGRAM_START_MS,
          endMs: timing.startMs + DIAGRAM_START_MS + Math.round(duration * DIAGRAM_SHARE),
        }
      : undefined;
    const marks: { characterKey: string; mark: "exclaim" | "sparkle"; atMs: number }[] = [];
    for (const planned of actors)
      for (const resolved of planned.actions)
        if (resolved.action.type === "react")
          marks.push({
            characterKey: planned.actor.characterKey,
            mark: resolved.action.mark,
            atMs: resolved.startMs,
          });
    if (narratorKey && !marks.length && (spec.purpose === "surprise" || spec.purpose === "payoff"))
      marks.push({
        characterKey: narratorKey,
        mark: spec.purpose === "surprise" ? "exclaim" : "sparkle",
        atMs: timing.voiceStartMs,
      });

    if (position > 0 && spec.transition === "wipe")
      sfx.push({ id: "whoosh", atMs: timing.startMs });
    for (const at of propsAtMs) sfx.push({ id: "pop", atMs: at });
    for (const entry of overlays)
      sfx.push({ id: entry.overlay.emphasis ? "thud" : "pop", atMs: entry.atMs });
    if (spec.diagram && diagram) {
      const steps = diagramSteps(spec.diagram);
      for (let i = 0; i < steps; i += 1)
        sfx.push({
          id: "tick",
          atMs: Math.round(diagram.startMs + (i / steps) * (diagram.endMs - diagram.startMs)),
        });
    }
    if (spec.purpose === "payoff") sfx.push({ id: "ding", atMs: timing.voiceStartMs });
    for (const planned of actors)
      for (const resolved of planned.actions) {
        if (resolved.action.type === "jump") sfx.push({ id: "thud", atMs: resolved.endMs });
        if (resolved.action.type === "react") sfx.push({ id: "pop", atMs: resolved.startMs });
      }
    for (const mark of marks)
      if (!sfx.some((cue) => Math.abs(cue.atMs - mark.atMs) < 60))
        sfx.push({ id: mark.mark === "sparkle" ? "ding" : "pop", atMs: mark.atMs });

    return {
      spec,
      startMs: timing.startMs,
      endMs: timing.endMs,
      voiceStartMs: timing.voiceStartMs,
      voiceEndMs: timing.voiceEndMs,
      words,
      actors,
      overlays,
      propsAtMs,
      ...(diagram ? { diagram } : {}),
      ...(art ? { art } : {}),
      ...(() => {
        const plate = art
          ? plateFraming(spec, input.locations, input.variationSeed, geo)
          : undefined;
        return plate ? { plate } : {};
      })(),
      ...(spec.dialogue?.length
        ? {
            speakers: spec.dialogue.flatMap((line, i) => {
              const range = lineRanges[i];
              return line.speakerKey === "narrator" || !range
                ? []
                : [{ characterKey: line.speakerKey, words: words.slice(range.from, range.to) }];
            }),
          }
        : {}),
      captions:
        spec.captionMode === "word"
          ? captionGroups(
              // Dialogue (slice 32): words an interruption cut off are pinned at zero length.
              spec.dialogue?.length ? words.filter((word) => word.endMs > word.startMs) : words,
              anchors.map((anchor) => anchor.sentenceEnd),
              input.captionWords,
              timing.endMs,
            )
          : spec.captionMode === "line" && words.length
            ? [{ words, startMs: timing.voiceStartMs, endMs: timing.endMs }]
            : [],
      marks: marks.map((mark) => ({ ...mark, atMs: Math.min(mark.atMs, timing.endMs - MARK_MS) })),
    };
  });
  const deadAfterMs = (input.visualLanguage ? grammarFromProfile(input.visualLanguage) : GRAMMAR)
    .deadFrameMs;
  if (input.motionGrammar)
    for (const scene of scenes) {
      const span = scene.endMs - scene.startMs;
      if (deadFrameMs(scene) > deadAfterMs && span > deadAfterMs)
        notes.push(`dead_frames:${scene.spec.index}`);
    }
  // One cue per sound per 60 ms: stacked identical sounds only get louder.
  const cues = [...sfx]
    .sort((a, b) => a.atMs - b.atMs)
    .filter(
      (cue, i, all) =>
        !all.slice(0, i).some((other) => other.id === cue.id && cue.atMs - other.atMs < 60),
    );
  return Object.freeze({
    ...(input.canvas === "landscape" ? { canvas: "landscape" as const } : {}),
    durationMs: input.durationMs,
    fps: 30,
    palette: input.palette,
    lineStyle: input.lineStyle ?? "clean",
    ...((input.compositing ?? input.visualLanguage?.compositing)
      ? { compositing: input.compositing ?? input.visualLanguage?.compositing }
      : {}),
    ...(input.motionGrammar ? { motionGrammar: true } : {}),
    ...(input.visualLanguage
      ? { visualLanguage: input.visualLanguage, grammar: grammarFromProfile(input.visualLanguage) }
      : {}),
    scenes,
    sfx: cues,
    plannedSilence: gapsBetween(
      input.timings.map((timing) => ({ startMs: timing.voiceStartMs, endMs: timing.voiceEndMs })),
      input.durationMs,
    ),
    plannedDark: [],
    notes,
  });
};
