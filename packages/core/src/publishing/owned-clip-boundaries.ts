import type { RenderTimingManifest } from "./render-timing-manifest.js";
import { parseRenderTimingManifest } from "./render-timing-manifest.js";

const maxClipDurationMs = 180_000;
const speechGapMs = 250;
const maxContextMs = 1_200;

export const refineOwnedClipBoundaries = (input: {
  manifest: RenderTimingManifest;
  fromChar: number;
  toChar: number;
}) => {
  const manifest = parseRenderTimingManifest(input.manifest);
  if (!manifest) throw new Error("clip_timing_unavailable");
  if (
    !Number.isSafeInteger(input.fromChar) ||
    !Number.isSafeInteger(input.toChar) ||
    input.fromChar < 0 ||
    input.toChar <= input.fromChar ||
    input.toChar > manifest.scriptLength
  )
    throw new Error("clip_semantic_span_invalid");

  const selected = manifest.words.filter(
    (word) =>
      word.fromChar !== undefined &&
      word.toChar !== undefined &&
      word.fromChar < input.toChar &&
      word.toChar > input.fromChar,
  );
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) throw new Error("clip_semantic_span_unmatched");

  const firstIndex = manifest.words.indexOf(first);
  const lastIndex = manifest.words.indexOf(last);
  const previous = manifest.words[firstIndex - 1];
  const next = manifest.words[lastIndex + 1];
  let startMs = first.startMs;
  let endMs = last.endMs;
  const boundaryBasis = ["word"];
  if (
    previous &&
    previous.sceneIndex === first.sceneIndex &&
    startMs - previous.endMs >= speechGapMs &&
    startMs - previous.endMs <= maxContextMs
  ) {
    startMs = previous.startMs;
    boundaryBasis.push("speech_gap");
  }
  if (
    next &&
    next.sceneIndex === last.sceneIndex &&
    next.startMs - endMs >= speechGapMs &&
    next.startMs - endMs <= maxContextMs
  ) {
    endMs = Math.min(endMs + speechGapMs, next.startMs);
    boundaryBasis.push("speech_gap");
  }

  const startScene = manifest.scenes.find((scene) => scene.index === first.sceneIndex);
  const endScene = manifest.scenes.find((scene) => scene.index === last.sceneIndex);
  if (!startScene || !endScene) throw new Error("clip_timing_invalid");
  startMs = Math.max(startScene.startMs, startMs);
  endMs = Math.min(endScene.endMs, endMs);
  const durationMs = endMs - startMs;
  if (durationMs <= 0 || durationMs > maxClipDurationMs) throw new Error("clip_duration_invalid");

  return {
    startMs,
    endMs,
    durationMs,
    fromChar: first.fromChar as number,
    toChar: last.toChar as number,
    firstWord: first.text,
    lastWord: last.text,
    alignmentStatus: manifest.alignmentStatus,
    boundaryBasis: [...new Set(boundaryBasis)],
  } as const;
};

export const refineOwnedClipTimeRange = (input: {
  manifest: RenderTimingManifest;
  startMs: number;
  endMs: number;
}) => {
  const manifest = parseRenderTimingManifest(input.manifest);
  if (!manifest) throw new Error("clip_timing_unavailable");
  if (
    !Number.isSafeInteger(input.startMs) ||
    !Number.isSafeInteger(input.endMs) ||
    input.startMs < 0 ||
    input.endMs <= input.startMs ||
    input.endMs > manifest.durationMs
  )
    throw new Error("clip_time_range_invalid");
  if (manifest.alignmentStatus !== "aligned") throw new Error("clip_timing_unavailable");

  const selected = manifest.words.filter(
    (word) => word.startMs < input.endMs && word.endMs > input.startMs,
  );
  const first = selected[0];
  const last = selected.at(-1);
  if (
    !first ||
    first.fromChar === undefined ||
    first.toChar === undefined ||
    !last ||
    last.toChar === undefined
  )
    throw new Error("clip_semantic_span_unmatched");
  return refineOwnedClipBoundaries({
    manifest,
    fromChar: first.fromChar,
    toChar: last.toChar,
  });
};
