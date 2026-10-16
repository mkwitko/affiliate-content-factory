import { actingGrammar, postureLeanDeg } from "../acting.js";
import { rigBuildFor } from "../character-bible.js";
import { type BackgroundArt } from "../background-art.js";
import { renderBackground } from "../backgrounds.js";
import { DEFAULT_RIM_COLOUR, lightVector } from "../compositing.js";
import { actorScaleFor, overlayFontSize, propAnchor, propScaleFor } from "../compose-scene.js";
import { renderDiagram } from "../diagrams.js";
import {
  type Canvas,
  type CanvasGeometry,
  escapeXml,
  fitFontSize,
  geometryFor,
  n,
  positionX,
} from "../layout.js";
import { renderProp } from "../props.js";
import {
  blendPoses,
  HEAD_TOP_Y,
  HEAD_Y,
  type PoseAngles,
  poseAngles,
  renderStickmanFrame,
  SHOULDER_Y,
  sketchSeed,
} from "../rigs/stick-v1.js";
import {
  anticipate,
  clamp,
  inOutCubic,
  lerp,
  outBack,
  outCubic,
  progress,
  settle,
  snapToClass,
  spring,
} from "./easing.js";
import type { MotionPlan, MotionWord, PlannedActor, PlannedScene, ResolvedAction } from "./plan.js";
import { TRANSITION_MS } from "./plan.js";
import { GRAMMAR } from "./tuning.js";

/**
 * One frame of a stickman_motion render as a standalone 1080x1920 (or landscape 1920x1080) SVG: a pure function of the
 * plan and the time, so the same (plan, t) always draws the same frame.
 */
/** Slight base zoom so pans and shakes never reveal the frame edge. */
const BASE_ZOOM = 1.03;
/** Painted backgrounds are farther than the stage: they move by this share of the camera. */
const PARALLAX_DEPTH = 0.5;
/** The still, or the loop frame on screen: each scene's own clock, wrapped by modulo. */
const artHref = (art: BackgroundArt, scene: PlannedScene, t: number): string => {
  const frames = art.loop?.frames ?? [];
  if (!art.loop || frames.length === 0) return art.href;
  const index = Math.floor(((t - scene.startMs) * art.loop.fps) / 1000);
  return frames[((index % frames.length) + frames.length) % frames.length] ?? art.href;
};
const PUSH_IN_MS = 1_000;
const PUSH_IN_ZOOM = 1.1;
const LOW_ANGLE_ZOOM = 1.08;
const LOW_ANGLE_DROP_PX = 40;
/** Peak sway; the base zoom leaves at least 16 px of margin, so the frame edge never shows. */
const HANDHELD_PX = 5;
/** Golden angle, rad: scene phases never line up, so consecutive handheld scenes sway differently. */
const GOLDEN_ANGLE = 2.399963;

/** Small steady sway: two slow sines per axis, phased by the scene index, never random. */
const handheldSway = (sceneIndex: number, t: number): Readonly<{ x: number; y: number }> => {
  const phase = sceneIndex * GOLDEN_ANGLE;
  const turn = (t / 1000) * 2 * Math.PI;
  return {
    x: HANDHELD_PX * (0.6 * Math.sin(0.55 * turn + phase) + 0.4 * Math.sin(1.7 * turn + 2 * phase)),
    y: HANDHELD_PX * (0.6 * Math.sin(0.43 * turn + 3 * phase) + 0.4 * Math.sin(1.3 * turn + phase)),
  };
};
const POSE_SETTLE_MS = 450;
const WALK_STEPS_PER_SEC = 1.8;
const PROP_POP_MS = 380;
const MARK_MS = 900;
const ARM_RAISE_MS = 250;
const BLINK_MS = 140;
const BREATH_AMPLITUDE = 0.012;
const IDLE_RAMP_MS = 200;
const GAZE_RAMP_MS = 200;
/** Actions that leave the body idle: a glance keeps breathing and blinking. */
const IDLE_WHILE: readonly string[] = ["look_at"];
/** 1 while the actor is idle, easing to 0 within IDLE_RAMP_MS of any action it performs. */
const idleWeight = (planned: PlannedActor, t: number): number =>
  planned.actions.reduce((weight, resolved) => {
    if (IDLE_WHILE.includes(resolved.action.type)) return weight;
    const gap =
      t < resolved.startMs ? resolved.startMs - t : t >= resolved.endMs ? t - resolved.endMs : 0;
    return Math.min(weight, clamp(gap / IDLE_RAMP_MS));
  }, 1);
/** Rig degrees (0 down, 90 forward, 180 up) of a straight arm reaching dx ahead and dy below. */
const aimDegrees = (dx: number, dy: number): number => (Math.atan2(dx, dy) * 180) / Math.PI;
/** 0 -> 1 over an action's first rampMs and back over its last: raise, hold, release. */
const envelope = (t: number, resolved: ResolvedAction, rampMs: number): number =>
  inOutCubic(
    Math.min(
      progress(t, resolved.startMs, rampMs),
      1 - progress(t, resolved.endMs - rampMs, rampMs),
    ),
  );

const walkingTypes: readonly string[] = ["enter", "exit", "walk_to"];

/**
 * Motion grammar envelope (slice 15): the entry winds up (when `windUp`), moves, overshoots and
 * settles over `entryMs` snapped to a duration class; the release eases out over `releaseMs`.
 * Returns values below 0 and above 1 on purpose.
 */
const grammarEnvelope = (
  g: typeof GRAMMAR,
  t: number,
  resolved: ResolvedAction,
  entryMs: number,
  releaseMs: number,
  windUp: boolean,
  overshoot: number,
): number => {
  const span = resolved.endMs - resolved.startMs;
  const entry = snapToClass(Math.min(entryMs, span * g.pointEntryShare), g.durationClassesFrames);
  if (t >= resolved.endMs - releaseMs)
    return inOutCubic(1 - progress(t, resolved.endMs - releaseMs, releaseMs));
  const k = progress(t, resolved.startMs, entry);
  return windUp
    ? anticipate(k, g.anticipationShare, g.anticipationDepth, overshoot)
    : settle(k, overshoot);
};

const cameraTransform = (
  geo: CanvasGeometry,
  scene: PlannedScene,
  t: number,
  depth = 1,
): string => {
  const CAMERA_FOCUS = geo.cameraFocus;
  const span = scene.endMs - scene.startMs;
  const u = progress(t, scene.startMs, span);
  const movement = scene.spec.camera.movement;
  let zoom =
    movement === "slow_zoom_in"
      ? lerp(1, 1.06, inOutCubic(u))
      : movement === "slow_zoom_out"
        ? lerp(1.06, 1, inOutCubic(u))
        : movement === "push_in"
          ? lerp(1, PUSH_IN_ZOOM, outCubic(progress(t, scene.startMs, PUSH_IN_MS)))
          : movement === "low_angle"
            ? LOW_ANGLE_ZOOM
            : lerp(1, 1.006, u);
  const panX =
    movement === "pan_left"
      ? lerp(24, -24, inOutCubic(u))
      : movement === "pan_right"
        ? lerp(-24, 24, inOutCubic(u))
        : 0;
  // A low angle scales about the ground line and drops the world, so the cast looms.
  const focusY = movement === "low_angle" ? geo.baselineY : CAMERA_FOCUS.y;
  const dropY = movement === "low_angle" ? LOW_ANGLE_DROP_PX : 0;
  const sway = movement === "handheld" ? handheldSway(scene.spec.index, t) : { x: 0, y: 0 };
  const punches = [
    ...(scene.spec.transition === "hard_cut" ? [scene.startMs] : []),
    ...scene.overlays.filter((entry) => entry.overlay.emphasis).map((entry) => entry.atMs),
  ];
  let bump = 0;
  for (const at of punches) {
    const d = (t - at) / 1000;
    if (d >= 0 && d < 0.62)
      bump += d < 0.12 ? inOutCubic(d / 0.12) : 1 - inOutCubic(Math.min(1, (d - 0.12) / 0.5));
  }
  zoom *= BASE_ZOOM * (1 + 0.05 * Math.min(1.4, bump));
  let shakeX = 0;
  let shakeY = 0;
  for (const planned of scene.actors)
    for (const resolved of planned.actions) {
      if (resolved.action.type !== "jump") continue;
      const d = (t - resolved.endMs) / 1000;
      if (d < 0 || d >= 0.5) continue;
      const amplitude = 16 * Math.exp(-d * 9);
      shakeX += amplitude * Math.sin(d * 70);
      shakeY += amplitude * Math.cos(d * 55);
    }
  // depth < 1 draws a far layer: it pans, shakes, sways, drops and zooms by that share of the
  // stage camera, about the same focus, so it composes with every camera move. The depth === 1
  // branches keep the original arithmetic, so existing frames stay byte-identical.
  const x =
    depth === 1
      ? CAMERA_FOCUS.x + panX + shakeX + sway.x
      : CAMERA_FOCUS.x + (panX + shakeX + sway.x) * depth;
  const y =
    depth === 1 ? focusY + dropY + shakeY + sway.y : focusY + (dropY + shakeY + sway.y) * depth;
  const z = depth === 1 ? zoom : 1 + (zoom - 1) * depth;
  return `translate(${n(x)},${n(y)}) scale(${Math.round(z * 10_000) / 10_000}) translate(${-CAMERA_FOCUS.x},${-focusY})`;
};

const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}]/gu, "") || "a";

/** Mouth shape for the letter being spoken: closed lips, round, teeth-on-lip or open. */
const visemeAt = (words: readonly MotionWord[], t: number, ink: string): string | undefined => {
  const word = words.find((entry) => t >= entry.startMs && t < entry.endMs);
  if (!word) return undefined;
  const k = clamp((t - word.startMs) / Math.max(60, word.endMs - word.startMs));
  const chars = letters(word.text);
  const ch = chars[Math.min(chars.length - 1, Math.floor(k * chars.length))] ?? "a";
  const syllables = Math.max(1, Math.round(chars.length / 3));
  const open = clamp(Math.abs(Math.sin(k * Math.PI * syllables)) * 0.85 + 0.15);
  if ("mbp".includes(ch)) return `<line x1="-12" y1="27" x2="12" y2="27" stroke-width="7"/>`;
  if ("ouwõôó".includes(ch))
    return `<ellipse cx="0" cy="28" rx="${n(8 + 2 * open)}" ry="${n(6 + 9 * open)}" fill="${ink}"/>`;
  if ("fv".includes(ch))
    return `<path d="M-14 24 Q0 32 14 24"/><line x1="-10" y1="22" x2="10" y2="22" stroke-width="4"/>`;
  return `<ellipse cx="0" cy="27" rx="${n(15 - 2 * open)}" ry="${n(3 + 12 * open)}" fill="${ink}"/>`;
};

/** Mouth shapes of the v2 lip sync (spec 11.5), in face coordinates. */
export type MouthShape = "CLOSED" | "OPEN" | "WIDE" | "ROUND";
const MOUTH_RATE_MS = 1000 / 12;
const HEAD_R_PX = 58;
const EXPRESSION_SWAP_MS = 150;
const VOWEL_SHAPE: Readonly<Record<string, MouthShape>> = Object.fromEntries([
  ..."aáâãà".split("").map((c) => [c, "OPEN" as const]),
  ..."eéêiíy".split("").map((c) => [c, "WIDE" as const]),
  ..."oóôõuúw".split("").map((c) => [c, "ROUND" as const]),
]);

/**
 * The mouth shape at t (slice 21): time snaps to a 12 Hz grid, so the shape changes at most 12
 * times a second and holds at least 2 frames at 30 fps; m, b and p close the lips; a consonant
 * takes the shape of the next vowel; a head under 60 px drops WIDE (3 states).
 */
export const mouthShapeFor = (
  words: readonly MotionWord[],
  t: number,
  headPx: number,
): MouthShape => {
  const at = Math.floor(t / MOUTH_RATE_MS) * MOUTH_RATE_MS;
  const word = words.find((entry) => at >= entry.startMs && at < entry.endMs);
  if (!word) return "CLOSED";
  const chars = letters(word.text);
  const k = clamp((at - word.startMs) / Math.max(60, word.endMs - word.startMs));
  const index = Math.min(chars.length - 1, Math.floor(k * chars.length));
  const ch = chars[index] ?? "a";
  let shape: MouthShape = "OPEN";
  if ("mbp".includes(ch)) shape = "CLOSED";
  else {
    const vowel = [...chars.slice(index), ...chars.slice(0, index).split("").reverse()].find(
      (c) => VOWEL_SHAPE[c],
    );
    shape = (vowel && VOWEL_SHAPE[vowel]) || "OPEN";
  }
  return headPx < 60 && shape === "WIDE" ? "OPEN" : shape;
};
const MOUTH_SVG: Readonly<Record<MouthShape, (ink: string) => string>> = {
  CLOSED: () => `<line x1="-14" y1="27" x2="14" y2="27" stroke-width="7"/>`,
  OPEN: (ink) => `<ellipse cx="0" cy="28" rx="13" ry="12" fill="${ink}"/>`,
  WIDE: (ink) => `<ellipse cx="0" cy="27" rx="18" ry="7" fill="${ink}"/>`,
  ROUND: (ink) => `<ellipse cx="0" cy="28" rx="8" ry="11" fill="${ink}"/>`,
};
const mouthShapeAt = (words: readonly MotionWord[], t: number, ink: string, headPx: number) =>
  words.some((entry) => t >= entry.startMs && t < entry.endMs)
    ? MOUTH_SVG[mouthShapeFor(words, t, headPx)](ink)
    : undefined;

type ActorState = Readonly<{ x: number; scale: number; lift: number; svg: string }>;

const actorAt = (
  plan: MotionPlan,
  scene: PlannedScene,
  planned: PlannedActor,
  t: number,
): ActorState => {
  const { actor, character } = planned;
  const geo = geometryFor(plan.canvas);
  const BASELINE_Y = geo.baselineY;
  const acting = plan.motionGrammar ? character.bible?.acting : undefined;
  const g = acting ? actingGrammar(plan.grammar ?? GRAMMAR, acting) : (plan.grammar ?? GRAMMAR);
  const first = planned.actions[0]?.action;
  let x = first?.type === "enter" ? geo.offstageX[first.from] : positionX(actor.position, geo);
  let facing = actor.facing ?? "right";
  let walking: PlannedActor["actions"][number] | undefined;
  for (const resolved of planned.actions) {
    if (!walkingTypes.includes(resolved.action.type) || t < resolved.startMs) continue;
    x = lerp(
      resolved.fromX,
      resolved.toX,
      inOutCubic(progress(t, resolved.startMs, resolved.endMs - resolved.startMs)),
    );
    if (t < resolved.endMs) {
      walking = resolved;
      facing = resolved.toX >= resolved.fromX ? "right" : "left";
    }
  }
  let pose: PoseAngles = blendPoses(
    poseAngles("neutral"),
    poseAngles(actor.pose),
    spring(progress(t, scene.startMs, POSE_SETTLE_MS) * 1.6),
  );
  let expression = actor.expression;
  let lift = 0;
  for (const resolved of planned.actions) {
    if (t < resolved.startMs) continue;
    const span = resolved.endMs - resolved.startMs;
    const k = progress(t, resolved.startMs, span);
    if (resolved.action.type === "pose") {
      const target = poseAngles(resolved.action.pose);
      // Emote steps lean the torso on top of the named pose.
      const leaned = resolved.lean ? { ...target, lean: target.lean + resolved.lean } : target;
      pose = blendPoses(
        pose,
        leaned,
        plan.motionGrammar
          ? anticipate(k, g.anticipationShare, g.anticipationDepth, g.overshoot)
          : spring(k * 1.6),
      );
    }
    if (resolved.action.type === "expression") expression = resolved.action.expression;
    if (resolved.action.type === "jump" && t < resolved.endMs) lift += 70 * Math.sin(Math.PI * k);
  }
  const baseScale = actorScaleFor(scene.spec, actor) * (character.bible?.body.scale ?? 1);
  const pointing = planned.actions.find(
    (resolved) =>
      resolved.action.type === "point_at" && t >= resolved.startMs && t < resolved.endMs,
  );
  if (pointing?.target) {
    // Presenters turn to what they point at; the facing returns when the point ends.
    const dx = pointing.target.x - x;
    if (dx !== 0) facing = dx > 0 ? "right" : "left";
    const aim = aimDegrees(Math.abs(dx), pointing.target.y - (BASELINE_Y + SHOULDER_Y * baseScale));
    pose = blendPoses(
      pose,
      { ...pose, frontArm: { upper: aim, lower: 0 } },
      plan.motionGrammar
        ? grammarEnvelope(g, t, pointing, g.pointEntryMs, ARM_RAISE_MS, true, g.overshoot)
        : envelope(t, pointing, ARM_RAISE_MS),
    );
  }
  if (walking) {
    const phase = ((t - walking.startMs) / 1000) * 2 * Math.PI * WALK_STEPS_PER_SEC;
    const fade = Math.min(1, (walking.endMs - t) / 180, (t - walking.startMs) / 120);
    const swing = Math.sin(phase);
    const armsRaised = pose.frontArm.upper > 50;
    pose = blendPoses(
      pose,
      {
        ...pose,
        frontLeg: { upper: 26 * swing, lower: -40 * Math.max(0, Math.cos(phase)) },
        backLeg: { upper: -26 * swing, lower: -40 * Math.max(0, -Math.cos(phase)) },
        ...(armsRaised
          ? {}
          : {
              frontArm: { upper: -24 * swing, lower: 16 + 8 * Math.cos(phase) },
              backArm: { upper: 24 * swing, lower: 16 - 8 * Math.cos(phase) },
            }),
        lean: pose.lean + 5,
      },
      Math.max(0, fade),
    );
  }
  const looking = planned.actions.find(
    (resolved) => resolved.action.type === "look_at" && t >= resolved.startMs && t < resolved.endMs,
  );
  let gaze: Readonly<{ x: number; y: number }> | undefined;
  if (looking?.target) {
    const dx = looking.target.x - x;
    const dy = looking.target.y - (BASELINE_Y + HEAD_Y * baseScale);
    const length = Math.hypot(dx, dy);
    if (length > 0) {
      const k =
        (plan.motionGrammar
          ? grammarEnvelope(g, t, looking, g.gazeEntryMs, GAZE_RAMP_MS, false, g.gazeOvershoot)
          : envelope(t, looking, GAZE_RAMP_MS)) / length;
      gaze = { x: (facing === "left" ? -dx : dx) * k, y: dy * k };
    }
  } else if (scene.speakers) {
    // Dialogue (slice 32): listeners turn to whoever speaks, from 250 ms before the line.
    const speaking = scene.speakers.find(
      (track) =>
        track.characterKey !== planned.actor.characterKey &&
        track.words.some((word) => t >= word.startMs - 250 && t < word.endMs + 150),
    );
    const other = speaking
      ? scene.actors.find((entry) => entry.actor.characterKey === speaking.characterKey)
      : undefined;
    if (other) {
      const dx = positionX(other.actor.position, geo) - x;
      if (dx !== 0) gaze = { x: ((facing === "left" ? -dx : dx) / Math.abs(dx)) * 0.7, y: 0 };
    }
  } else if (plan.motionGrammar && !planned.narrator) {
    // Conversation gaze (slice 21): a listener with no look_at of its own turns its eyes to the
    // narrator while a word is spoken, easing in and out with the speech.
    const speaker = scene.actors.find((other) => other.narrator);
    const speaking = scene.words.some((word) => t >= word.startMs - 150 && t < word.endMs + 150);
    if (speaker && speaking) {
      const dx = positionX(speaker.actor.position, geo) - x;
      const length = Math.abs(dx);
      if (length > 0) gaze = { x: ((facing === "left" ? -dx : dx) / length) * 0.6, y: 0 };
    }
  }
  const idle = idleWeight(planned, t);
  const still = plan.motionGrammar === true && scene.spec.holdMode === "intentional_still";
  if (plan.motionGrammar) {
    // Walk start and stop: a lean back before the first step, a forward lean that settles after
    // the last; the body bobs on each step so it travels on arcs, not a straight line.
    let extraLean = 0;
    for (const resolved of planned.actions) {
      if (!walkingTypes.includes(resolved.action.type)) continue;
      const u0 = (t - resolved.startMs) / g.walkStartMs;
      if (u0 >= 0 && u0 < 1) extraLean += g.walkStartLeanDeg * Math.sin(Math.PI * u0);
      const u1 = (t - resolved.endMs) / g.walkStopMs;
      if (u1 >= 0 && u1 < 1) extraLean += g.walkStopLeanDeg * Math.sin(Math.PI * u1) * (1 - u1);
    }
    if (walking) {
      const phase = ((t - walking.startMs) / 1000) * Math.PI * WALK_STEPS_PER_SEC;
      const fade = Math.min(1, (walking.endMs - t) / 180, (t - walking.startMs) / 120);
      lift += g.walkBobPx * Math.abs(Math.sin(phase)) * Math.max(0, fade);
    }
    // Moving hold: an idle actor shifts its weight slowly, seeded by its breathing phase.
    if (!still)
      extraLean +=
        g.holdSwayDeg *
        idle *
        Math.sin(
          ((t - scene.startMs) / g.holdSwayPeriodMs + planned.idle.breathPhase) * 2 * Math.PI,
        );
    if (acting) extraLean += postureLeanDeg(acting);
    if (extraLean !== 0) pose = { ...pose, lean: pose.lean + extraLean };
  }
  const blinkAt = planned.idle.blinksAtMs.find((at) => t >= at && t < at + BLINK_MS);
  const idleBlink =
    idle >= 1 && blinkAt !== undefined ? Math.sin(((t - blinkAt) / BLINK_MS) * Math.PI) : 0;
  // Expression swaps hide behind a blink (slice 21): eyes close across the 150 ms change.
  const swap = plan.motionGrammar
    ? planned.actions.find(
        (resolved) =>
          resolved.action.type === "expression" &&
          Math.abs(t - resolved.startMs) < EXPRESSION_SWAP_MS / 2,
      )
    : undefined;
  const blink = swap
    ? Math.max(
        idleBlink,
        Math.sin(((t - swap.startMs + EXPRESSION_SWAP_MS / 2) / EXPRESSION_SWAP_MS) * Math.PI),
      )
    : idleBlink;
  const breath = Math.sin(
    ((t - scene.startMs) / planned.idle.breathPeriodMs + planned.idle.breathPhase) * 2 * Math.PI,
  );
  const scale = baseScale * (1 + BREATH_AMPLITUDE * idle * breath * (still ? 0 : 1));
  const track = scene.speakers?.find((entry) => entry.characterKey === planned.actor.characterKey);
  const mouth = scene.speakers
    ? track
      ? mouthShapeAt(track.words, t, character.palette.line, HEAD_R_PX * 2 * scale)
      : undefined
    : planned.narrator
      ? plan.motionGrammar
        ? mouthShapeAt(scene.words, t, character.palette.line, HEAD_R_PX * 2 * scale)
        : visemeAt(scene.words, t, character.palette.line)
      : undefined;
  const trail = walking
    ? [0, 1, 2]
        .map((i) => {
          const dir = facing === "right" ? 1 : -1;
          const y = BASELINE_Y - (150 + i * 34) * scale;
          return `<line x1="${n(x - dir * (90 + i * 26) * scale)}" y1="${n(y)}" x2="${n(x - dir * (150 + i * 26) * scale)}" y2="${n(y)}" stroke="${character.palette.line}" stroke-width="6" stroke-linecap="round" stroke-opacity="${n(0.25 + 0.15 * Math.sin(t / 50 + i))}"/>`;
        })
        .join("")
    : "";
  const profile = plan.compositing;
  const look = {
    angles: pose,
    expression,
    palette: character.palette,
    x,
    baselineY: BASELINE_Y,
    scale,
    facing,
    accessory: character.accessory,
    wardrobe: character.wardrobe,
    sketch: plan.lineStyle === "sketch" ? { seed: sketchSeed(character.key) } : undefined,
    blink,
    gaze,
    mouth,
    lift,
    extremities: true,
    grounded: scene.art !== undefined,
    ...(character.bible ? { build: rigBuildFor(character.bible) } : {}),
    ...(profile
      ? {
          shadowCast: {
            dx: profile.lighting.shadowOffset[0],
            dy: profile.lighting.shadowOffset[1],
            strength: profile.lighting.shadowStrength,
          },
        }
      : {}),
  } as const;
  // Rim light: the same figure in the rim colour, nudged toward the key light and drawn behind,
  // so a light edge shows on the lit side. No SVG filter (librsvg filters cost ~2 s per frame).
  let rim = "";
  if (profile?.rim?.enabled) {
    const colour = profile.rim.colour ?? DEFAULT_RIM_COLOUR;
    const toward = lightVector(profile);
    const w = profile.rim.widthPx * scale;
    const wardrobe = character.wardrobe;
    rim = renderStickmanFrame({
      ...look,
      x: x + toward.x * w,
      baselineY: BASELINE_Y + toward.y * w,
      palette: { line: colour, fill: colour, accent: colour },
      wardrobe: wardrobe
        ? {
            ...wardrobe,
            ...(wardrobe.hair ? { hair: { ...wardrobe.hair, colour } } : {}),
            ...(wardrobe.top ? { top: { ...wardrobe.top, colour } } : {}),
            ...(wardrobe.bottoms ? { bottoms: { ...wardrobe.bottoms, colour } } : {}),
          }
        : undefined,
      shadowCast: { dx: 0, dy: 0, strength: 0 },
    });
  }
  return {
    x,
    scale,
    lift,
    svg: trail + rim + renderStickmanFrame(look),
  };
};

const exclaim = (t: number, at: number, x: number, y: number, accent: string, ink: string) => {
  const k = outBack(progress(t, at, 300));
  const fade = 1 - progress(t, at + 600, 300);
  return `<g opacity="${n(fade)}" transform="translate(${n(x)},${n(y - 20 * k)}) scale(${Math.round(Math.max(0.01, k) * 100) / 100})"><text text-anchor="middle" font-family="Inter, sans-serif" font-weight="900" font-size="110" fill="${accent}" stroke="${ink}" stroke-width="6" paint-order="stroke">!</text></g>`;
};

const sparkles = (t: number, at: number, x: number, y: number, accent: string, ink: string) => {
  const k = outCubic(progress(t, at, 700));
  const fade = 1 - progress(t, at + 450, 450);
  const stars = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    const r = 60 + 110 * k;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    return `<path d="M${n(px)} ${n(py - 16)} L${n(px + 5)} ${n(py - 5)} L${n(px + 16)} ${n(py)} L${n(px + 5)} ${n(py + 5)} L${n(px)} ${n(py + 16)} L${n(px - 5)} ${n(py + 5)} L${n(px - 16)} ${n(py)} L${n(px - 5)} ${n(py - 5)} Z" fill="${accent}" stroke="${ink}" stroke-width="3"/>`;
  }).join("");
  return `<g opacity="${n(fade)}">${stars}</g>`;
};

/** Estimated advance of a word in bold Inter, px; capitals run wider. */
export const wordWidth = (word: string, size: number) =>
  [...word].reduce(
    (sum, ch) => sum + (ch === ch.toUpperCase() && /\p{L}/u.test(ch) ? 0.72 : 0.58),
    0,
  ) * size;

/** Overlay text lands word by word: each word scales down from 1.7x with a small twist. */
const slam = (plan: MotionPlan, entry: PlannedScene["overlays"][number], t: number): string => {
  if (t < entry.atMs) return "";
  const geo = geometryFor(plan.canvas);
  const { overlay } = entry;
  const size = overlayFontSize(overlay, geo);
  const words = overlay.text.trim().split(/\s+/);
  const gap = size * 0.3;
  const total =
    words.reduce((sum, word) => sum + wordWidth(word, size), 0) + gap * (words.length - 1);
  let cursor = geo.frame.width / 2 - total / 2;
  return words
    .map((word, i) => {
      const width = wordWidth(word, size);
      const cx = cursor + width / 2;
      cursor += width + gap;
      const start = entry.atMs + i * 90;
      if (t < start) return "";
      const k = progress(t, start, 220);
      const scale = lerp(1.7, 1, outCubic(k));
      const turn = (1 - outCubic(k)) * (i % 2 ? 6 : -6);
      const fill =
        overlay.emphasis && i === words.length - 1 ? plan.palette.accent : plan.palette.text;
      const settled = k >= 1;
      return `<g${settled ? "" : ` opacity="${n(clamp(k * 3))}"`} transform="translate(${n(cx)},${geo.overlayY[overlay.position]})${settled ? "" : ` scale(${Math.round(scale * 1000) / 1000}) rotate(${n(turn)})`}"><text text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="${size}" fill="${fill}" stroke="${plan.palette.surface}" stroke-width="12" paint-order="stroke" stroke-linejoin="round">${escapeXml(word)}</text></g>`;
    })
    .join("");
};

const drawScene = (plan: MotionPlan, scene: PlannedScene, t: number): string => {
  const { spec } = scene;
  const geo = geometryFor(plan.canvas);
  const BASELINE_Y = geo.baselineY;
  const depth = plan.compositing?.depth;
  // A profile whose mid depth differs from the stage draws the procedural setting as its own
  // layer; otherwise it stays inside the stage group exactly as before.
  const separateMid = !scene.art && depth !== undefined && depth.mid !== depth.hero;
  const layers: string[] =
    scene.art || separateMid ? [] : [renderBackground(spec.background, plan.palette, geo)];
  if (spec.diagram && scene.diagram)
    layers.push(
      renderDiagram(
        spec.diagram,
        plan.palette,
        progress(t, scene.diagram.startMs, scene.diagram.endMs - scene.diagram.startMs),
        geo,
      ),
    );
  spec.props.forEach((prop, i) => {
    const at = scene.propsAtMs[i] ?? scene.startMs;
    if (t < at) return;
    const anchor = propAnchor(prop, geo);
    const body = renderProp({
      type: prop.type,
      ...anchor,
      scale: propScaleFor(spec),
      label: prop.label,
      palette: { line: plan.palette.line, accent: plan.palette.accent },
    });
    const k = progress(t, at, PROP_POP_MS);
    layers.push(
      k >= 1
        ? body
        : `<g transform="translate(${n(anchor.x)},${n(anchor.y)}) scale(${Math.round(Math.max(0.01, outBack(k)) * 1000) / 1000}) translate(${n(-anchor.x)},${n(-anchor.y)})">${body}</g>`,
    );
  });
  const states = new Map<string, ActorState>();
  for (const planned of scene.actors) {
    const state = actorAt(plan, scene, planned, t);
    states.set(planned.actor.characterKey, state);
    layers.push(state.svg);
  }
  for (const mark of scene.marks) {
    if (t < mark.atMs || t >= mark.atMs + MARK_MS) continue;
    const state = states.get(mark.characterKey);
    if (!state) continue;
    const headY = BASELINE_Y + (HEAD_TOP_Y - 30) * state.scale - state.lift * state.scale;
    layers.push(
      mark.mark === "exclaim"
        ? exclaim(
            t,
            mark.atMs,
            state.x + 90 * state.scale,
            headY,
            plan.palette.accent,
            plan.palette.line,
          )
        : sparkles(
            t,
            mark.atMs,
            state.x,
            headY + 60 * state.scale,
            plan.palette.accent,
            plan.palette.line,
          ),
    );
  }
  const overlays = scene.overlays.map((entry) => slam(plan, entry, t)).join("");
  const box = geo.artBox;
  const centre = { x: geo.frame.width / 2, y: geo.frame.height / 2 };
  const plate = scene.plate;
  const far = scene.art
    ? plate
      ? // A location plate (slice 24): the zone crop centres and zooms the overscan box, then
        // the far layer's parallax applies; the lighting tint covers the plate only.
        `<g data-art="1" transform="${cameraTransform(geo, scene, t, depth?.far ?? PARALLAX_DEPTH)}"><g transform="translate(${centre.x},${centre.y}) scale(${plate.zoom}) translate(${n(-(plate.box.x + plate.cx * plate.box.width))},${n(-(plate.box.y + plate.cy * plate.box.height))})"><image href="${artHref(scene.art, scene, t)}" x="${n(plate.box.x)}" y="${n(plate.box.y)}" width="${n(plate.box.width)}" height="${n(plate.box.height)}" preserveAspectRatio="xMidYMid slice"/></g>${plate.grade ? `<rect x="-200" y="-200" width="${geo.frame.width + 400}" height="${geo.frame.height + 400}" fill="${plate.grade.tint}" fill-opacity="${plate.grade.alpha}"/>` : ""}</g>`
      : `<g data-art="1" transform="${cameraTransform(geo, scene, t, depth?.far ?? PARALLAX_DEPTH)}"><image href="${artHref(scene.art, scene, t)}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid slice"/></g>`
    : separateMid
      ? `<g data-layer="mid" transform="${cameraTransform(geo, scene, t, depth.mid)}">${renderBackground(spec.background, plan.palette, geo)}</g>`
      : "";
  return `${far}<g transform="${cameraTransform(geo, scene, t, depth?.hero ?? 1)}">${layers.join("")}</g>${overlays}`;
};

/** Caption band: the current group in a dark box, the word being spoken in the accent colour. */
const drawCaptions = (plan: MotionPlan, scene: PlannedScene, t: number): string => {
  const geo = geometryFor(plan.canvas);
  const cx = geo.frame.width / 2;
  const group = scene.captions.find((entry) => t >= entry.startMs && t < entry.endMs);
  if (!group || !group.words.length) return "";
  const text = group.words.map((word) => word.text).join(" ");
  const profile = plan.visualLanguage;
  const size = fitFontSize(text, profile?.type.captionPx[1] ?? 64, geo.captionFitWidth);
  const accent = profile?.palette.roles.accent ?? plan.palette.accent;
  const textOn = profile?.palette.roles.textOn ?? "#ffffff";
  const plateFill = profile?.palette.roles.textPlate ?? plan.palette.line;
  const width = Math.min(geo.captionMaxWidth, wordWidth(text, size) + 70);
  const height = size * 1.55;
  const cy = (geo.captionBand.top + geo.captionBand.bottom) / 2;
  const k = progress(t, group.startMs, 120);
  const pop =
    k >= 1
      ? ""
      : ` transform="translate(${cx},${cy}) scale(${n(lerp(0.9, 1, outCubic(k)))}) translate(${-cx},${-cy})"`;
  const spans = group.words
    .map((word, i) => {
      const next = group.words[i + 1];
      const speaking = t >= word.startMs && t < (next?.startMs ?? group.endMs);
      return `<tspan fill="${speaking ? accent : textOn}">${escapeXml(word.text)}${next ? " " : ""}</tspan>`;
    })
    .join("");
  return `<g data-caption="1"${pop}><rect x="${n(cx - width / 2)}" y="${n(cy - height / 2)}" width="${n(width)}" height="${n(height)}" rx="22" fill="${plateFill}" fill-opacity="0.88"/><text x="${cx}" y="${n(cy + size * 0.35)}" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="${size}" xml:space="preserve">${spans}</text></g>`;
};

const VIGNETTE_GRADIENT = `<radialGradient id="mm-vignette" cx="50%" cy="42%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.16"/></radialGradient>`;
const DEFS = `<defs>${VIGNETTE_GRADIENT}<filter id="mm-whip" x="-20%" y="-5%" width="140%" height="110%"><feGaussianBlur stdDeviation="28 0"/></filter></defs>`;
const vignetteRect = (geo: CanvasGeometry) =>
  `<rect width="${geo.frame.width}" height="${geo.frame.height}" fill="url(#mm-vignette)"/>`;

/**
 * The vignette alone over white (v2 slice 17, B2): rasterised once per render, its red channel
 * is the per-pixel multiplier (0..255) a renderer applies to raw frames composed with
 * `{ vignette: false }`. Measured pixel-identical to drawing the gradient in every frame, at
 * about 40% of the raster cost (the full-frame radial gradient dominates librsvg time).
 */
export const vignetteMaskSvg = (canvas?: Canvas): string => {
  const { frame } = geometryFor(canvas);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}"><defs>${VIGNETTE_GRADIENT}</defs><rect width="${frame.width}" height="${frame.height}" fill="#fff"/>${vignetteRect(geometryFor(canvas))}</svg>`;
};
export const VIGNETTE_MASK_SVG = vignetteMaskSvg();

export const sceneIndexAt = (plan: MotionPlan, t: number): number => {
  let index = 0;
  plan.scenes.forEach((scene, i) => {
    if (scene.startMs <= t) index = i;
  });
  return index;
};

export const composeMotionFrame = (
  plan: MotionPlan,
  t: number,
  options: Readonly<{ vignette?: boolean }> = {},
): string => {
  const geo = geometryFor(plan.canvas);
  const { frame } = geo;
  const index = sceneIndexAt(plan, t);
  const scene = plan.scenes[index];
  if (!scene) throw new Error("motion_plan_empty");
  const previous = plan.scenes[index - 1];
  const k = progress(t, scene.startMs, TRANSITION_MS);
  let world: string;
  if (previous && k < 1 && scene.spec.transition !== "hard_cut") {
    const before = drawScene(plan, previous, t);
    const after = drawScene(plan, scene, t);
    if (scene.spec.transition === "fade") world = `${before}<g opacity="${n(k)}">${after}</g>`;
    else {
      const e = inOutCubic(k);
      world = `<g transform="translate(${n(-frame.width * e)},0)" filter="url(#mm-whip)">${before}</g><g transform="translate(${n(frame.width * (1 - e))},0)" filter="url(#mm-whip)">${after}</g>`;
    }
  } else world = drawScene(plan, scene, t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">${DEFS}<rect width="${frame.width}" height="${frame.height}" fill="${plan.palette.surface}"/>${world}${drawCaptions(plan, scene, t)}${options.vignette === false ? "" : vignetteRect(geo)}</svg>`;
};
