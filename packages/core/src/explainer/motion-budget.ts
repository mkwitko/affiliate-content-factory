import { isKnownToken, MOTION_TOKENS } from "./motion-tokens.js";
import { narrationMsPerWord } from "./script-guards.js";
import { type SceneSpec, sceneWordCount } from "./scene-spec.js";
import { BUDGET } from "./motion/tuning.js";

/**
 * Motion budget and cadence checks on a SceneSpec list before render (v2 slice 16). Timing is
 * estimated from narration words, the same way `validateSceneSpecs` anchors actions. Every
 * finding is a WARN, `<reason>:<scene index>`, with a fix hint; none blocks a storyboard.
 */
export type MotionBudgetWarning =
  | `motion_budget:${number}`
  | `camera_information:${number}`
  | `cut_hold:${number}`
  | `cadence_gap:${number}`;

export const MOTION_BUDGET_HINTS: Readonly<Record<string, string>> = Object.freeze({
  motion_budget:
    "Too much moves at once: mark lesser actions priority secondary or ambient, or move them to a later word.",
  camera_information:
    "The camera moves while a diagram or overlay lands: use movement none or handheld in this scene.",
  cut_hold:
    "An action starts right on the cut: anchor it one or two words later so the eye lands first.",
  cadence_gap:
    "Nothing new happens for over 4 s: add an action, an overlay, or split the scene (or mark holdMode intentional_still).",
});

export const motionBudgetHint = (warning: string): string | undefined =>
  MOTION_BUDGET_HINTS[warning.slice(0, warning.lastIndexOf(":"))];

type Beat = Readonly<{ atMs: number; cost: number; primary: boolean; entrance: boolean }>;

const beatsOf = (scene: SceneSpec, msPerWord: number): readonly Beat[] => [
  ...scene.actors.flatMap((actor) =>
    (actor.actions ?? []).map((action) => ({
      atMs: action.atWord * msPerWord,
      cost: BUDGET.actionCost[action.type] * BUDGET.priorityScale[action.priority ?? "primary"],
      primary: (action.priority ?? "primary") === "primary",
      entrance: action.type === "enter",
    })),
  ),
  // A token costs its own budget (its stages are one beat), primary like a gesture.
  ...scene.actors.flatMap((actor) =>
    (actor.motionTokens ?? []).flatMap((token) =>
      isKnownToken(token)
        ? [
            {
              atMs: token.atWord * msPerWord,
              cost: MOTION_TOKENS[token.token].budgetCost,
              primary: true,
              entrance: false,
            },
          ]
        : [],
    ),
  ),
  // Props pop and the diagram draws right after the cut; overlays land on their scene start.
  ...scene.props.map(() => ({ atMs: 200, cost: BUDGET.propCost, primary: false, entrance: false })),
  ...(scene.diagram
    ? [{ atMs: 300, cost: BUDGET.diagramCost, primary: true, entrance: false }]
    : []),
  ...scene.overlays.map(() => ({
    atMs: 0,
    cost: BUDGET.overlayCost,
    primary: true,
    entrance: false,
  })),
];

export const motionBudgetWarnings = (input: {
  scenes: readonly SceneSpec[];
  language: string;
  sceneTexts: readonly string[];
}): readonly MotionBudgetWarning[] => {
  const msPerWord = narrationMsPerWord(input.language);
  return input.scenes.flatMap((scene): MotionBudgetWarning[] => {
    const out: MotionBudgetWarning[] = [];
    const sceneMs = sceneWordCount(input.sceneTexts[scene.index - 1] ?? "") * msPerWord;
    const beats = beatsOf(scene, msPerWord);
    const camera = BUDGET.cameraCost[scene.camera.movement];
    const windowed = beats.some(
      (beat) =>
        camera +
          beats
            .filter((other) => other.atMs >= beat.atMs && other.atMs < beat.atMs + BUDGET.windowMs)
            .reduce((sum, other) => sum + other.cost, 0) >
        BUDGET.maxPerWindow,
    );
    if (windowed) out.push(`motion_budget:${scene.index}`);
    if (camera > 0 && (scene.diagram !== undefined || scene.overlays.length > 0))
      out.push(`camera_information:${scene.index}`);
    if (
      beats.some(
        (beat) => beat.primary && !beat.entrance && beat.atMs > 0 && beat.atMs < BUDGET.cutHoldMs,
      )
    )
      out.push(`cut_hold:${scene.index}`);
    if (scene.holdMode !== "intentional_still") {
      const starts = [
        0,
        ...beats.filter((beat) => beat.primary).map((beat) => beat.atMs),
        sceneMs,
      ].sort((a, b) => a - b);
      const gap = starts.slice(1).reduce((max, at, i) => Math.max(max, at - (starts[i] ?? 0)), 0);
      if (gap > BUDGET.maxCadenceGapMs) out.push(`cadence_gap:${scene.index}`);
    }
    return out;
  });
};
