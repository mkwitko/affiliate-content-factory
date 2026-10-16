import type { MotionTokenId, SceneMotionToken } from "./motion-tokens.js";
import type { MotionWord } from "./motion/plan.js";
import { DIALOGUE } from "./motion/tuning.js";
import { NARRATION_WORD } from "./scene-spec.js";

/**
 * Dialogue (Stickman v2 spec 16, slice 32). A line is a character range of the approved script
 * inside its scene, so every spoken word stays verbatim copy; the scene's lines cover its text in
 * order. Each line is synthesised in its speaker's voice and placed with the gap rules below.
 */
export type DialogueReaction = Readonly<{
  reactorKey: string;
  /** Word index inside the line. */
  atWord: number;
  token: MotionTokenId;
  delayMs?: number | undefined;
}>;
export type DialogueLine = Readonly<{
  /** A cast key in the scene, or "narrator" for the niche voice off screen. */
  speakerKey: string;
  fromChar: number;
  toChar: number;
  pauseBeforeMs?: number | undefined;
  interruptsPrev?: boolean | undefined;
  reactions?: readonly DialogueReaction[] | undefined;
}>;

export type DialogueRejection =
  | "dialogue_coverage"
  | "dialogue_speaker_missing"
  | "dialogue_speakers_limit"
  | "dialogue_narrator_interrupts"
  | "dialogue_reaction_invalid";

/** Word ranges of each line in its scene (indices into the scene's narration words). */
export const lineWordRanges = (
  sceneText: string,
  sceneFromChar: number,
  lines: readonly DialogueLine[],
): readonly Readonly<{ from: number; to: number }>[] =>
  lines.map((line) => {
    const before = sceneText.slice(0, Math.max(0, line.fromChar - sceneFromChar));
    const inside = sceneText.slice(line.fromChar - sceneFromChar, line.toChar - sceneFromChar);
    const from = [...before.matchAll(NARRATION_WORD)].length;
    return { from, to: from + [...inside.matchAll(NARRATION_WORD)].length };
  });

/**
 * Listener reactions as motion tokens per reacting actor, anchored at the reaction's word in
 * the scene; shared by the validator (limits, timing) and the planner (slice 32).
 */
export const dialogueReactionTokens = (
  lines: readonly DialogueLine[],
  sceneText: string,
  sceneFromChar: number,
): ReadonlyMap<string, readonly SceneMotionToken[]> => {
  const ranges = lineWordRanges(sceneText, sceneFromChar, lines);
  const out = new Map<string, SceneMotionToken[]>();
  lines.forEach((line, i) => {
    for (const reaction of line.reactions ?? []) {
      const list = out.get(reaction.reactorKey) ?? [];
      list.push({
        token: reaction.token,
        atWord: (ranges[i]?.from ?? 0) + reaction.atWord,
        ...(reaction.delayMs ? { offsetMs: reaction.delayMs } : {}),
      });
      out.set(reaction.reactorKey, list);
    }
  });
  return out;
};

/** Structural rules; null when the dialogue is valid for its scene. */
export const checkDialogue = (input: {
  lines: readonly DialogueLine[];
  scene: Readonly<{
    fromChar: number;
    toChar: number;
    actors: readonly Readonly<{ characterKey: string }>[];
  }>;
  sceneText: string;
  knownTokens: (token: string) => boolean;
}): DialogueRejection | null => {
  const { lines, scene } = input;
  if (lines.length === 0) return null;
  const keys = new Set(scene.actors.map((actor) => actor.characterKey));
  let cursor = scene.fromChar;
  for (const [i, line] of lines.entries()) {
    const gap = input.sceneText.slice(cursor - scene.fromChar, line.fromChar - scene.fromChar);
    if (
      line.fromChar < cursor ||
      gap.trim() !== "" ||
      line.toChar <= line.fromChar ||
      line.toChar > scene.toChar
    )
      return "dialogue_coverage";
    const lineWords = [
      ...input.sceneText
        .slice(line.fromChar - scene.fromChar, line.toChar - scene.fromChar)
        .matchAll(NARRATION_WORD),
    ].length;
    cursor = line.toChar;
    if (line.speakerKey !== "narrator" && !keys.has(line.speakerKey))
      return "dialogue_speaker_missing";
    if (
      line.interruptsPrev &&
      (i === 0 || line.speakerKey === "narrator" || lines[i - 1]?.speakerKey === "narrator")
    )
      return "dialogue_narrator_interrupts";
    for (const reaction of line.reactions ?? [])
      if (
        !keys.has(reaction.reactorKey) ||
        reaction.reactorKey === line.speakerKey ||
        !input.knownTokens(reaction.token) ||
        !Number.isInteger(reaction.atWord) ||
        reaction.atWord < 0 ||
        reaction.atWord >= lineWords
      )
        return "dialogue_reaction_invalid";
  }
  if (input.sceneText.slice(cursor - scene.fromChar).trim() !== "") return "dialogue_coverage";
  if (new Set(lines.map((line) => line.speakerKey)).size > DIALOGUE.maxSpeakers)
    return "dialogue_speakers_limit";
  return null;
};

export type LineClip = Readonly<{ durationMs: number; words: readonly MotionWord[] }>;
export type DialogueTimeline = Readonly<{
  durationMs: number;
  /** Each line's start, relative to the scene's voice start. */
  startsMs: readonly number[];
  /**
   * Scene words (line words shifted to their start), in time order, one per spoken token. Words
   * an interruption cuts off stay, pinned at zero length at the interruption, so word counts
   * still match the script; zero-length words are never captioned.
   */
  words: readonly MotionWord[];
  /** Per line: where the clip is cut and from when it is ducked, both relative to the clip. */
  edits: readonly Readonly<{ trimMs?: number; duckFromMs?: number }>[];
}>;

/**
 * Places line clips on the scene clock: speaker gap, same-speaker gap, explicit pauses, and
 * interruptions that start under the previous line, whose tail is ducked and cut at the first
 * word boundary after the interruption starts.
 */
export const composeDialogueTimeline = (
  lines: readonly DialogueLine[],
  clips: readonly LineClip[],
): DialogueTimeline => {
  if (lines.length !== clips.length) throw new Error("dialogue_clip_count_invalid");
  const startsMs: number[] = [];
  const edits: { trimMs?: number; duckFromMs?: number }[] = clips.map(() => ({}));
  const words: MotionWord[] = [];
  let end = 0;
  lines.forEach((line, i) => {
    const clip = clips[i] as LineClip;
    const previous = lines[i - 1];
    let start: number;
    if (i === 0) start = Math.min(DIALOGUE.maxPauseMs, line.pauseBeforeMs ?? 0);
    else if (line.interruptsPrev) {
      start = Math.max(startsMs[i - 1] ?? 0, end - DIALOGUE.interruptOverlapMs);
      const prevClip = clips[i - 1] as LineClip;
      const prevStart = startsMs[i - 1] ?? 0;
      const underMs = start - prevStart;
      // Cut at the end of the word being spoken when the interruption lands, or right there
      // when it lands in silence; later words of that line are never heard.
      const spanning = prevClip.words.find(
        (word) => word.startMs < underMs && word.endMs >= underMs,
      );
      const cut = spanning ? spanning.endMs : underMs;
      edits[i - 1] = { trimMs: Math.round(cut), duckFromMs: Math.round(underMs) };
      const first = words.length - prevClip.words.length;
      for (let w = Math.max(0, first); w < words.length; w += 1) {
        const word = words[w] as MotionWord;
        if (word.startMs - prevStart >= underMs)
          words[w] = { text: word.text, startMs: Math.round(start), endMs: Math.round(start) };
      }
    } else {
      const gap =
        previous?.speakerKey === line.speakerKey
          ? DIALOGUE.sameSpeakerGapMs
          : DIALOGUE.speakerGapMs;
      start = end + Math.max(gap, Math.min(DIALOGUE.maxPauseMs, line.pauseBeforeMs ?? 0));
    }
    start = Math.round(start);
    startsMs.push(start);
    for (const word of clip.words)
      words.push({ text: word.text, startMs: word.startMs + start, endMs: word.endMs + start });
    end = start + clip.durationMs;
  });
  return { durationMs: Math.round(end), startsMs, words, edits };
};

/** Advisory rules (WARN): interruption and dramatic-pause frequency over a storyboard. */
export const dialogueWarnings = (
  scenes: readonly Readonly<{ index: number; dialogue?: readonly DialogueLine[] | undefined }>[],
  estimatedDurationMs: number,
): readonly string[] => {
  const all = scenes.flatMap((scene) => scene.dialogue ?? []);
  const interrupts = all.filter((line) => line.interruptsPrev).length;
  const pauses = all.filter((line) => (line.pauseBeforeMs ?? 0) >= DIALOGUE.dramaticPauseMs).length;
  return [
    ...(interrupts > Math.max(1, Math.floor(estimatedDurationMs / DIALOGUE.interruptEveryMs))
      ? [`dialogue_interruptions:${interrupts}`]
      : []),
    ...(pauses > Math.max(1, Math.floor(estimatedDurationMs / DIALOGUE.pauseEveryMs))
      ? [`dialogue_pauses:${pauses}`]
      : []),
  ];
};
