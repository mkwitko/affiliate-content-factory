import { positionX } from "../explainer/layout.js";
import { withExpandedTokens } from "../explainer/motion-tokens.js";
import {
  type ActorAction,
  ARM_BUSY,
  actionDurationMs,
  EMOTE_MIN_MS,
  LOCOMOTION,
  MAX_ACTION_MS,
  MAX_ACTIONS_PER_ACTOR,
  MAX_ACTIONS_PER_SCENE,
  MAX_WALK_PX_PER_SEC,
  MIN_ACTION_MS,
  OFFSTAGE_X,
  SCENE_END_TOLERANCE_MS,
  type SceneActor,
  type SceneSpec,
  sceneWordCount,
  walkTargetX,
} from "../explainer/scene-spec.js";
import { narrationMsPerWord } from "../explainer/script-guards.js";

/**
 * Action timing made mechanical (director v5). The director picks what an actor does and on which
 * word; this pass makes the timing legal against the same estimate the validator uses (word index
 * times the language's ms per word). Per actor, in order: anchors and explicit durations are
 * clamped into range; then each remaining conflict (running past the scene, an incompatible
 * overlap, a move after exit, a late enter, too many actions) is resolved by shortening the
 * action to the time left, delaying the less important action past the other, shortening it to
 * end before the other, and only then removing it. A step is kept only when it lowers the
 * conflict count. Motion-token expansions are fixed. The final validator is unchanged.
 */

type Entry = Readonly<{
  action: ActorAction;
  /** Index into the actor's raw actions; undefined for a motion-token expansion. */
  raw: number | undefined;
  startMs: number;
  endMs: number;
  distance: number;
}>;
type Conflict = readonly [Entry] | readonly [Entry, Entry];

const PRIORITY_RANK = { primary: 0, secondary: 1, ambient: 2 } as const;
const TYPE_RANK: Readonly<Record<ActorAction["type"], number>> = {
  walk_to: 0,
  enter: 0,
  exit: 0,
  point_at: 0,
  jump: 1,
  pose: 1,
  emote: 1,
  look_at: 1,
  expression: 2,
  react: 2,
};
/** Lower is more important; the later action loses a tie. */
const rank = (entry: Entry) =>
  PRIORITY_RANK[entry.action.priority ?? "primary"] * 10 + TYPE_RANK[entry.action.type];
const loserOf = (a: Entry, b: Entry): Entry =>
  a.raw === undefined
    ? b
    : b.raw === undefined
      ? a
      : rank(a) !== rank(b)
        ? rank(a) > rank(b)
          ? a
          : b
        : a.startMs > b.startMs
          ? a
          : b;

const hasDuration = (action: ActorAction): boolean =>
  action.type !== "expression" && action.type !== "react";
const minDurationMs = (action: ActorAction, distance: number): number =>
  !hasDuration(action)
    ? actionDurationMs(action, distance)
    : action.type === "emote"
      ? EMOTE_MIN_MS
      : Math.max(MIN_ACTION_MS, Math.ceil((distance * 1000) / MAX_WALK_PX_PER_SEC));
const withDuration = (action: ActorAction, durationMs: number): ActorAction =>
  hasDuration(action) ? ({ ...action, durationMs: Math.round(durationMs) } as ActorAction) : action;
const overlaps = (a: Entry, b: Entry) => a.startMs < b.endMs && b.startMs < a.endMs;

/** Mirrors the validator's timeline: sorted by word, walking distance tracked from home. */
const timeline = (
  actor: SceneActor,
  raw: readonly ActorAction[],
  msPerWord: number,
): readonly Entry[] => {
  const fixed = withExpandedTokens({ ...actor, actions: [] }).actions ?? [];
  const all = [
    ...raw.map((action, i) => ({ action, raw: i as number | undefined })),
    ...fixed.map((action) => ({ action, raw: undefined })),
  ].sort(
    (a, b) =>
      a.action.atWord - b.action.atWord || (a.action.offsetMs ?? 0) - (b.action.offsetMs ?? 0),
  );
  const homeX = positionX(actor.position);
  const first = all[0]?.action;
  let x = first?.type === "enter" ? OFFSTAGE_X[first.from] : homeX;
  return all.map(({ action, raw: index }) => {
    const targetX = walkTargetX(action, homeX);
    const distance = targetX === undefined ? 0 : Math.abs(targetX - x);
    if (targetX !== undefined) x = targetX;
    const startMs = action.atWord * msPerWord + (action.offsetMs ?? 0);
    return {
      action,
      raw: index,
      startMs,
      endMs: startMs + actionDurationMs(action, distance),
      distance,
    };
  });
};

/** Every rule of the validator's action check that two of one actor's actions can break. */
const conflicts = (entries: readonly Entry[], limitMs: number): readonly Conflict[] => {
  const found: Conflict[] = entries
    .filter((entry) => entry.endMs > limitMs)
    .map((entry) => [entry] as const);
  const moves = entries.filter((entry) => LOCOMOTION.includes(entry.action.type));
  for (const [i, move] of moves.entries()) {
    const previous = moves[i - 1];
    if (previous && move.startMs < previous.endMs) found.push([previous, move]);
    if (i > 0 && move.action.type === "enter" && moves[0]) found.push([moves[0], move]);
  }
  const poses = entries.filter((entry) => entry.action.type === "pose");
  for (const [i, pose] of poses.entries()) {
    const previous = poses[i - 1];
    if (previous && previous.action.atWord === pose.action.atWord) found.push([previous, pose]);
  }
  const exit = entries.find((entry) => entry.action.type === "exit");
  if (exit)
    for (const entry of entries)
      if (entry !== exit && entry.startMs >= exit.startMs) found.push([exit, entry]);
  for (const [i, a] of entries.entries())
    for (const b of entries.slice(i + 1)) {
      if (!overlaps(a, b)) continue;
      const types = [a.action.type, b.action.type];
      if (
        (types.includes("point_at") &&
          ARM_BUSY.includes(types[0] === "point_at" ? (types[1] ?? "") : (types[0] ?? ""))) ||
        (types[0] === "look_at" && types[1] === "look_at") ||
        types.includes("emote")
      )
        found.push([a, b]);
    }
  return found;
};

const normalizeActor = (
  actor: SceneActor,
  wordCount: number,
  msPerWord: number,
): readonly ActorAction[] | undefined => {
  if (!actor.actions?.length || wordCount === 0) return actor.actions;
  const limitMs = wordCount * msPerWord + SCENE_END_TOLERANCE_MS;
  const count = (raw: readonly ActorAction[]) =>
    conflicts(timeline(actor, raw, msPerWord), limitMs).length;
  // Clamp anchors, then explicit durations, into the validator's ranges.
  let raw: ActorAction[] = actor.actions.map((action) => ({
    ...action,
    atWord: Math.min(Math.max(0, Math.round(action.atWord)), wordCount - 1),
  }));
  raw = timeline(actor, raw, msPerWord)
    .filter((entry) => entry.raw !== undefined)
    .sort((a, b) => (a.raw ?? 0) - (b.raw ?? 0))
    .map(({ action, distance }) =>
      "durationMs" in action && action.durationMs !== undefined
        ? withDuration(
            action,
            Math.min(MAX_ACTION_MS, Math.max(minDurationMs(action, distance), action.durationMs)),
          )
        : action,
    );
  const tokens = actor.motionTokens?.length ?? 0;
  for (let step = 0; step < 4 * actor.actions.length; step += 1) {
    const entries = timeline(actor, raw, msPerWord);
    const listed = entries.filter((entry) => entry.raw !== undefined);
    if (raw.length + tokens > MAX_ACTIONS_PER_ACTOR) {
      const weakest = [...listed].sort((a, b) => rank(b) - rank(a) || b.startMs - a.startMs)[0];
      raw = raw.filter((_, i) => i !== weakest?.raw);
      continue;
    }
    const conflict = conflicts(entries, limitMs)[0];
    if (!conflict) break;
    const before = count(raw);
    const replace = (index: number, action: ActorAction) =>
      raw.map((current, i) => (i === index ? action : current));
    const [a, b] = conflict;
    const loser = b ? loserOf(a, b) : a;
    const winner = b ? (loser === a ? b : a) : undefined;
    if (loser.raw === undefined) break;
    const index = loser.raw;
    const { action } = loser;
    const options: ActorAction[][] = [];
    // Shorten to the time left in the scene, or to end before the other action starts.
    const ends = [limitMs, ...(winner && winner.startMs > loser.startMs ? [winner.startMs] : [])];
    for (const end of ends) {
      const fit = end - loser.startMs;
      if (
        hasDuration(action) &&
        fit >= minDurationMs(action, loser.distance) &&
        fit < loser.endMs - loser.startMs
      )
        options.push(replace(index, withDuration(action, fit)));
    }
    // Delay past the other action, shortened to fit when needed.
    if (winner) {
      const atWord = Math.ceil((winner.endMs - (action.offsetMs ?? 0)) / msPerWord);
      if (atWord > action.atWord && atWord < wordCount) {
        const delayed = { ...action, atWord } as ActorAction;
        options.push(replace(index, delayed));
        const fit = limitMs - atWord * msPerWord;
        if (hasDuration(action) && fit >= minDurationMs(action, loser.distance))
          options.push(
            replace(index, withDuration(delayed, Math.min(fit, loser.endMs - loser.startMs))),
          );
      }
    }
    raw = options.find((option) => count(option) < before) ?? raw.filter((_, i) => i !== index);
  }
  return raw;
};

export const normalizeActionTimings = (
  scenes: readonly SceneSpec[],
  body: string,
  language: string,
): readonly SceneSpec[] => {
  const msPerWord = narrationMsPerWord(language);
  return scenes.map((scene) => {
    const wordCount = sceneWordCount(body.slice(scene.fromChar, scene.toChar));
    let actors = scene.actors.map((actor) => {
      const actions = normalizeActor(actor, wordCount, msPerWord);
      return actions === actor.actions ? actor : { ...actor, actions };
    });
    // Scene-wide limit: drop the least important raw actions first.
    const total = () =>
      actors.reduce((sum, a) => sum + (a.actions?.length ?? 0) + (a.motionTokens?.length ?? 0), 0);
    while (total() > MAX_ACTIONS_PER_SCENE) {
      const weakest = actors
        .flatMap((actor, i) =>
          timeline(actor, actor.actions ?? [], msPerWord).flatMap((entry) =>
            entry.raw === undefined ? [] : [{ i, entry }],
          ),
        )
        .sort((a, b) => rank(b.entry) - rank(a.entry) || b.entry.startMs - a.entry.startMs)[0];
      if (!weakest) break;
      actors = actors.map((actor, i) =>
        i === weakest.i
          ? { ...actor, actions: (actor.actions ?? []).filter((_, j) => j !== weakest.entry.raw) }
          : actor,
      );
    }
    return actors.every((actor, i) => actor === scene.actors[i]) ? scene : { ...scene, actors };
  });
};
