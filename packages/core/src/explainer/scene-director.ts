import { LAYOUT_IDS } from "./layouts.js";
import { SHOT_KINDS } from "./shots.js";
import { MOTION_TOKEN_IDS } from "./motion-tokens.js";
import type { ContentScript } from "../content/editorial.js";
import { BACKGROUNDS, type BackgroundId } from "./backgrounds.js";
import type { ExplainerCharacter } from "./explainer-context.js";
import type { Location } from "./locations.js";
import type { MotionWord } from "./motion/plan.js";
import { PROPS, type PropId } from "./props.js";
import {
  EXPRESSIONS,
  type ExpressionId,
  POSES,
  type PoseId,
  STICK_V1_ACTIONS,
} from "./rigs/stick-v1.js";
import {
  type ActorActionType,
  CAMERA_MOVEMENTS,
  EMOTE_MIN_MS,
  EMOTIONS,
  type Emotion,
} from "./scene-spec.js";

type NonEmpty<T> = readonly [T, ...T[]];
/** The closed vocabulary a director may use; anything outside it fails the schema. */
export type SceneDirectorCatalog = Readonly<{
  actions: NonEmpty<ActorActionType>;
  poses: NonEmpty<PoseId>;
  expressions: NonEmpty<ExpressionId>;
  props: NonEmpty<PropId>;
  backgrounds: NonEmpty<BackgroundId>;
  emotions: NonEmpty<Emotion>;
  cameraMovements: NonEmpty<(typeof CAMERA_MOVEMENTS)[number]>;
  /** Shortest emote the motion planner can play. */
  emoteMinMs: number;
  /** Motion tokens the director should prefer over raw actions (v2 slice 22). */
  motionTokens?: NonEmpty<(typeof MOTION_TOKEN_IDS)[number]>;
  shots?: NonEmpty<(typeof SHOT_KINDS)[number]>;
  layouts?: NonEmpty<(typeof LAYOUT_IDS)[number]>;
}>;
/** Everything stick-v1 and the scene composer can draw today. */
export const STICK_V1_CATALOG: SceneDirectorCatalog = Object.freeze({
  actions: STICK_V1_ACTIONS,
  poses: POSES,
  expressions: EXPRESSIONS,
  props: PROPS,
  backgrounds: BACKGROUNDS,
  emotions: EMOTIONS,
  cameraMovements: CAMERA_MOVEMENTS,
  emoteMinMs: EMOTE_MIN_MS,
  motionTokens: MOTION_TOKEN_IDS,
  shots: SHOT_KINDS,
  layouts: LAYOUT_IDS,
});

export type SceneDirectorInput = Readonly<{
  /** Approved and immutable; the director never edits copy. */
  script: ContentScript;
  persona: readonly ExplainerCharacter[];
  catalog: SceneDirectorCatalog;
  /** Kokoro words in script order when narration already exists; empty otherwise. */
  timing: readonly MotionWord[];
  /** The niche's locations; the director names their ids, never coordinates (v2 spec 14.2). */
  locations?: readonly Location[];
}>;
/** Second attempt only: the rejected output and the validator errors it produced. */
export type SceneDirectorCorrection = Readonly<{ previous: unknown; errors: readonly string[] }>;

/**
 * Proposes SceneSpec[] for an approved script (spec 5.7). The result is typed `unknown` on
 * purpose: it is model output, and directScenes validates it (Zod, createStoryboard, guards)
 * before anything treats it as SceneSpec[]. An adapter returns the decoded JSON value, or the
 * raw text when the reply is not JSON; it throws only when the model could not be reached.
 */
export type SceneDirector = Readonly<{
  direct(
    input: SceneDirectorInput & Readonly<{ correction?: SceneDirectorCorrection | undefined }>,
  ): Promise<unknown>;
}>;
