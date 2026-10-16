import { refineOwnedClipBoundaries } from "./owned-clip-boundaries.js";
import type { RenderTimingManifest } from "./render-timing-manifest.js";

export const OWNED_CLIP_CANDIDATE_PROMPT_VERSION = "owned-clip-candidates-v1";
export const CANDIDATE_SIGNALS = [
  "strong_hook",
  "surprise",
  "practical_value",
  "story_peak",
  "quotable",
  "conflict",
  "revelation",
  "emotional_peak",
] as const;
export type CandidateSignal = (typeof CANDIDATE_SIGNALS)[number];

/** Model output, already shape-validated at the MCP boundary. Untrusted until evaluated. */
export type OwnedClipCandidateInput = Readonly<{
  fromChar: number;
  toChar: number;
  title: string;
  hook: string;
  reason: string;
  signals: readonly CandidateSignal[];
  score: number;
}>;
export type OwnedClipCandidate = OwnedClipCandidateInput &
  Readonly<{
    startMs: number;
    endMs: number;
    durationMs: number;
    durationScore: number;
    sceneIndex: number;
  }>;
export type CandidateDropReason =
  | "span_invalid"
  | "hook_not_opening"
  | "snap_failed"
  | "duration_out_of_range"
  | "duplicate"
  | "scene_cap";

const MIN_MS = 10_000;
const MAX_MS = 180_000;
const HOOK_WINDOW_CHARS = 40;
const MAX_PER_SCENE = 2;

/** 1 inside 30-60 s, linear to 0 at 15 s and 90 s. */
export const durationScore = (ms: number): number =>
  ms >= 30_000 && ms <= 60_000
    ? 1
    : Math.max(0, ms < 30_000 ? (ms - 15_000) / 15_000 : (90_000 - ms) / 30_000);

export const evaluateOwnedClipCandidates = (input: {
  manifest: RenderTimingManifest;
  scriptBody: string;
  candidates: readonly OwnedClipCandidateInput[];
  count: number;
}): { kept: OwnedClipCandidate[]; dropped: { index: number; reason: CandidateDropReason }[] } => {
  const dropped: { index: number; reason: CandidateDropReason }[] = [];
  const valid: (OwnedClipCandidate & { index: number; rank: number })[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    const drop = (reason: CandidateDropReason) => {
      dropped.push({ index, reason });
    };
    const toChar = Math.min(candidate.toChar, input.manifest.scriptLength);
    if (
      !Number.isSafeInteger(candidate.fromChar) ||
      candidate.fromChar < 0 ||
      toChar <= candidate.fromChar
    ) {
      drop("span_invalid");
      continue;
    }
    const opening = input.scriptBody.slice(candidate.fromChar, toChar).indexOf(candidate.hook);
    if (!candidate.hook || opening < 0 || opening > HOOK_WINDOW_CHARS) {
      drop("hook_not_opening");
      continue;
    }
    let snapped: ReturnType<typeof refineOwnedClipBoundaries>;
    try {
      snapped = refineOwnedClipBoundaries({
        manifest: input.manifest,
        fromChar: candidate.fromChar,
        toChar,
      });
    } catch (error) {
      drop(
        error instanceof Error && error.message === "clip_duration_invalid"
          ? "duration_out_of_range"
          : "snap_failed",
      );
      continue;
    }
    if (snapped.durationMs < MIN_MS || snapped.durationMs > MAX_MS) {
      drop("duration_out_of_range");
      continue;
    }
    const scene = input.manifest.scenes.find(
      (s) => snapped.startMs >= s.startMs && snapped.startMs < s.endMs,
    );
    const score = durationScore(snapped.durationMs);
    valid.push({
      ...candidate,
      fromChar: snapped.fromChar,
      toChar: snapped.toChar,
      startMs: snapped.startMs,
      endMs: snapped.endMs,
      durationMs: snapped.durationMs,
      durationScore: score,
      sceneIndex: scene?.index ?? 0,
      index,
      rank: candidate.score * score,
    });
  }

  const kept: (OwnedClipCandidate & { index: number })[] = [];
  for (const c of [...valid].sort((a, b) => b.rank - a.rank || a.index - b.index)) {
    const overlaps = kept.some((k) => {
      const shared = Math.min(k.endMs, c.endMs) - Math.max(k.startMs, c.startMs);
      return shared > 0.5 * Math.min(k.durationMs, c.durationMs);
    });
    if (overlaps) dropped.push({ index: c.index, reason: "duplicate" });
    else if (kept.filter((k) => k.sceneIndex === c.sceneIndex).length >= MAX_PER_SCENE)
      dropped.push({ index: c.index, reason: "scene_cap" });
    else kept.push(c);
  }
  return {
    kept: kept.slice(0, input.count).map(({ index: _index, ...rest }) => rest),
    dropped: dropped.sort((a, b) => a.index - b.index),
  };
};

const WINDOW_MS = 90_000;
const OVERLAP_MS = 30_000;
const SINGLE_WINDOW_MAX_MS = 360_000;
export type CandidateWindow = Readonly<{
  fromChar: number;
  toChar: number;
  startMs: number;
  endMs: number;
  text: string;
}>;

/** Scene-aligned narration windows: one for a script of 6 minutes or less, else ~90 s with 30 s overlap. */
export const buildCandidateWindows = (
  manifest: RenderTimingManifest,
  scriptBody: string,
): CandidateWindow[] => {
  const scenes = manifest.scenes;
  const make = (first: number, last: number): CandidateWindow => {
    const a = scenes[first] as (typeof scenes)[number];
    const b = scenes[last] as (typeof scenes)[number];
    return {
      fromChar: a.fromChar,
      toChar: b.toChar,
      startMs: a.startMs,
      endMs: b.endMs,
      text: scriptBody.slice(a.fromChar, b.toChar),
    };
  };
  if (scenes.length === 0) return [];
  if (manifest.durationMs <= SINGLE_WINDOW_MAX_MS) return [make(0, scenes.length - 1)];
  const windows: CandidateWindow[] = [];
  let start = 0;
  while (start < scenes.length) {
    let end = start;
    while (
      end < scenes.length - 1 &&
      (scenes[end] as (typeof scenes)[number]).endMs -
        (scenes[start] as (typeof scenes)[number]).startMs <
        WINDOW_MS
    )
      end += 1;
    windows.push(make(start, end));
    if (end === scenes.length - 1) break;
    const resume = (scenes[end] as (typeof scenes)[number]).endMs - OVERLAP_MS;
    const next = scenes.findIndex((s) => s.startMs >= resume);
    start = next > start ? next : start + 1;
  }
  return windows;
};
