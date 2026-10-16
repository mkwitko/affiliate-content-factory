import type { ActionTarget, ActorAction, LookTarget, SceneActor } from "./scene-spec.js";

/**
 * Motion tokens (Stickman v2 spec 15.2, slice 22): named acting beats that expand into the
 * existing actions, frame-offset from one narration word. An emote owns the body, so a token's
 * reaction mark lands after its emote ends. Versioned so an old storyboard keeps
 * its motion. The director should prefer tokens; raw actions stay valid. The rig has no nod,
 * shrug or facepalm yet, so those tokens use the closest existing poses (recorded in the plan).
 */
export const MOTION_TOKEN_IDS = [
  "POINT_BEAT",
  "DOUBLE_TAKE",
  "SMALL_FLINCH",
  "BIG_FLINCH",
  "SHRUG_LOOK",
  "SLOW_REALIZATION",
  "DEADPAN_LOOK",
  "NERVOUS_GLANCE",
  "ANGRY_TURN",
  "FACEPALM_HOLD",
  "CELEBRATE_SMALL",
  "CELEBRATE_BIG",
] as const;
export type MotionTokenId = (typeof MOTION_TOKEN_IDS)[number];
export const MOTION_TOKENS_VERSION = 1;

/** A token placed on an actor: anchored like an action, optional target for aimed tokens. */
export type SceneMotionToken = Readonly<{
  token: MotionTokenId;
  atWord: number;
  target?: ActionTarget | undefined;
  version?: number | undefined;
  /** Internal (slice 32): extra delay of a listener reaction; the MCP schema refuses it. */
  offsetMs?: number | undefined;
}>;

/** An action without its anchor: distributive, so each action keeps its own fields. */
type Built = ActorAction extends infer A ? (A extends unknown ? Omit<A, "atWord"> : never) : never;
type Stage = Readonly<{
  offsetFrames: number;
  durationFrames?: number;
  build: (target: ActionTarget | undefined) => Built | null;
}>;
export type MotionToken = Readonly<{
  id: MotionTokenId;
  version: 1;
  requiresTarget: boolean;
  /** Attention cost for the motion budget (slice 16), instead of summing the stages. */
  budgetCost: number;
  stages: readonly Stage[];
}>;

const look = (target: ActionTarget | undefined): Built | null =>
  target ? { type: "look_at", target: target as LookTarget } : null;
const point = (target: ActionTarget | undefined): Built | null =>
  target ? { type: "point_at", target } : null;
const frames = (count: number) => Math.round((count * 1000) / 30);

export const MOTION_TOKENS: Readonly<Record<MotionTokenId, MotionToken>> = {
  POINT_BEAT: {
    id: "POINT_BEAT",
    version: 1,
    requiresTarget: true,
    budgetCost: 3,
    stages: [
      { offsetFrames: 0, durationFrames: 9, build: look },
      { offsetFrames: 3, durationFrames: 36, build: point },
    ],
  },
  DOUBLE_TAKE: {
    id: "DOUBLE_TAKE",
    version: 1,
    requiresTarget: true,
    budgetCost: 3,
    stages: [
      { offsetFrames: 0, durationFrames: 9, build: look },
      { offsetFrames: 12, build: () => ({ type: "expression", expression: "surprised" }) },
      { offsetFrames: 12, build: () => ({ type: "react", mark: "exclaim" }) },
    ],
  },
  SMALL_FLINCH: {
    id: "SMALL_FLINCH",
    version: 1,
    requiresTarget: false,
    budgetCost: 2,
    stages: [
      { offsetFrames: 0, build: () => ({ type: "expression", expression: "worried" }) },
      { offsetFrames: 2, durationFrames: 12, build: () => ({ type: "pose", pose: "surprised" }) },
    ],
  },
  BIG_FLINCH: {
    id: "BIG_FLINCH",
    version: 1,
    requiresTarget: false,
    budgetCost: 4,
    stages: [
      { offsetFrames: 0, durationFrames: 30, build: () => ({ type: "emote", emotion: "worried" }) },
      { offsetFrames: 32, build: () => ({ type: "react", mark: "exclaim" }) },
    ],
  },
  SHRUG_LOOK: {
    id: "SHRUG_LOOK",
    version: 1,
    requiresTarget: false,
    budgetCost: 2,
    stages: [
      { offsetFrames: 0, build: () => ({ type: "expression", expression: "confused" }) },
      { offsetFrames: 3, durationFrames: 18, build: () => ({ type: "pose", pose: "confused" }) },
    ],
  },
  SLOW_REALIZATION: {
    id: "SLOW_REALIZATION",
    version: 1,
    requiresTarget: false,
    budgetCost: 3,
    stages: [
      { offsetFrames: 0, build: () => ({ type: "expression", expression: "thinking" }) },
      { offsetFrames: 6, durationFrames: 24, build: () => ({ type: "pose", pose: "thinking" }) },
      { offsetFrames: 30, build: () => ({ type: "react", mark: "sparkle" }) },
    ],
  },
  DEADPAN_LOOK: {
    id: "DEADPAN_LOOK",
    version: 1,
    requiresTarget: true,
    budgetCost: 1,
    stages: [
      { offsetFrames: 0, build: () => ({ type: "expression", expression: "neutral" }) },
      { offsetFrames: 0, durationFrames: 36, build: look },
    ],
  },
  NERVOUS_GLANCE: {
    id: "NERVOUS_GLANCE",
    version: 1,
    requiresTarget: true,
    budgetCost: 2,
    stages: [
      { offsetFrames: 0, durationFrames: 9, build: look },
      { offsetFrames: 2, build: () => ({ type: "expression", expression: "scared" }) },
    ],
  },
  ANGRY_TURN: {
    id: "ANGRY_TURN",
    version: 1,
    requiresTarget: false,
    budgetCost: 3,
    stages: [
      {
        offsetFrames: 0,
        durationFrames: 30,
        build: () => ({ type: "emote", emotion: "frustrated" }),
      },
    ],
  },
  FACEPALM_HOLD: {
    id: "FACEPALM_HOLD",
    version: 1,
    requiresTarget: false,
    budgetCost: 2,
    stages: [
      { offsetFrames: 0, durationFrames: 18, build: () => ({ type: "pose", pose: "thinking" }) },
      { offsetFrames: 4, build: () => ({ type: "expression", expression: "tired" }) },
    ],
  },
  CELEBRATE_SMALL: {
    id: "CELEBRATE_SMALL",
    version: 1,
    requiresTarget: false,
    budgetCost: 2,
    stages: [
      { offsetFrames: 0, build: () => ({ type: "expression", expression: "happy" }) },
      { offsetFrames: 3, durationFrames: 15, build: () => ({ type: "pose", pose: "celebrating" }) },
    ],
  },
  CELEBRATE_BIG: {
    id: "CELEBRATE_BIG",
    version: 1,
    requiresTarget: false,
    budgetCost: 4,
    stages: [
      {
        offsetFrames: 0,
        durationFrames: 36,
        build: () => ({ type: "emote", emotion: "triumphant" }),
      },
      { offsetFrames: 38, build: () => ({ type: "react", mark: "sparkle" }) },
    ],
  },
};

export const isKnownToken = (
  entry: Readonly<{ token: string; version?: number | undefined }>,
): boolean =>
  (MOTION_TOKEN_IDS as readonly string[]).includes(entry.token) &&
  (entry.version ?? MOTION_TOKENS_VERSION) === MOTION_TOKENS_VERSION;

/** A token's actions: anchored to its word, shifted by the stage offset. Unknown → []. */
export const expandToken = (entry: SceneMotionToken): readonly ActorAction[] => {
  if (!isKnownToken(entry)) return [];
  const token = MOTION_TOKENS[entry.token];
  return token.stages.flatMap((stage) => {
    const built = stage.build(entry.target);
    if (!built) return [];
    return [
      {
        ...built,
        atWord: entry.atWord,
        ...(stage.offsetFrames || entry.offsetMs
          ? { offsetMs: frames(stage.offsetFrames) + (entry.offsetMs ?? 0) }
          : {}),
        ...(stage.durationFrames &&
        "type" in built &&
        built.type !== "expression" &&
        built.type !== "react"
          ? { durationMs: Math.max(200, frames(stage.durationFrames)) }
          : {}),
      } as ActorAction,
    ];
  });
};

/** The actor with its tokens expanded into actions (raw actions first, order kept). */
export const withExpandedTokens = (actor: SceneActor): SceneActor =>
  actor.motionTokens?.length
    ? { ...actor, actions: [...(actor.actions ?? []), ...actor.motionTokens.flatMap(expandToken)] }
    : actor;
