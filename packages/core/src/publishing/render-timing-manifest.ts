import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";

const maxSerializedBytes = 2 * 1024 * 1024;
const checksumPattern = /^[a-f\d]{64}$/i;

export type RenderTimingScene = Readonly<{
  index: number;
  fromChar: number;
  toChar: number;
  startMs: number;
  endMs: number;
  sourceAssetId: string;
  sourceAssetChecksum: string;
}>;

export type RenderTimingWord = Readonly<{
  text: string;
  fromChar?: number;
  toChar?: number;
  startMs: number;
  endMs: number;
  sceneIndex: number;
}>;

export type RenderTimingManifest = Readonly<{
  version: 1;
  workspaceId: WorkspaceId;
  renderId: string;
  storyboardId: string;
  storyboardChecksum: string;
  scriptId: string;
  scriptChecksum: string;
  scriptLength: number;
  renderedAssetId: string;
  renderedAssetChecksum: string;
  rendererVersion: number;
  alignmentVersion: 1;
  alignmentStatus: "aligned" | "partial" | "scene_only";
  durationMs: number;
  audioTimelineOffsetMs: number;
  measuredAt: string;
  scenes: readonly RenderTimingScene[];
  words: readonly RenderTimingWord[];
  manifestChecksum: string;
}>;

export type RenderTimingManifestInput = Omit<
  RenderTimingManifest,
  "version" | "alignmentVersion" | "alignmentStatus" | "manifestChecksum"
>;

const invalid = (): never => {
  throw new Error("long_form_timing_manifest_invalid");
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
};

const canonicalJson = (manifest: Omit<RenderTimingManifest, "manifestChecksum">): string =>
  JSON.stringify(stableJsonValue(manifest));

const calculateChecksum = (manifest: Omit<RenderTimingManifest, "manifestChecksum">): string =>
  createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");

const serializedSize = (manifest: RenderTimingManifest): number =>
  new TextEncoder().encode(JSON.stringify(manifest)).byteLength;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isChecksum = (value: unknown): value is string =>
  typeof value === "string" && checksumPattern.test(value);

const validateManifest = (value: unknown): value is RenderTimingManifest => {
  if (!isRecord(value)) return false;
  const topKeys = [
    "version",
    "workspaceId",
    "renderId",
    "storyboardId",
    "storyboardChecksum",
    "scriptId",
    "scriptChecksum",
    "scriptLength",
    "renderedAssetId",
    "renderedAssetChecksum",
    "rendererVersion",
    "alignmentVersion",
    "alignmentStatus",
    "durationMs",
    "audioTimelineOffsetMs",
    "measuredAt",
    "scenes",
    "words",
    "manifestChecksum",
  ];
  if (!hasExactKeys(value, topKeys)) return false;
  if (
    value.version !== 1 ||
    value.alignmentVersion !== 1 ||
    !isNonEmptyString(value.workspaceId) ||
    !isNonEmptyString(value.renderId) ||
    !isNonEmptyString(value.storyboardId) ||
    !isChecksum(value.storyboardChecksum) ||
    !isNonEmptyString(value.scriptId) ||
    !isChecksum(value.scriptChecksum) ||
    !isInteger(value.scriptLength) ||
    value.scriptLength < 1 ||
    !isNonEmptyString(value.renderedAssetId) ||
    !isChecksum(value.renderedAssetChecksum) ||
    !isInteger(value.rendererVersion) ||
    value.rendererVersion < 1 ||
    !["aligned", "partial", "scene_only"].includes(String(value.alignmentStatus)) ||
    !isInteger(value.durationMs) ||
    value.durationMs < 1 ||
    value.durationMs > 900_000 ||
    !isInteger(value.audioTimelineOffsetMs) ||
    value.audioTimelineOffsetMs < 0 ||
    typeof value.measuredAt !== "string" ||
    !Number.isFinite(Date.parse(value.measuredAt)) ||
    !isChecksum(value.manifestChecksum) ||
    !Array.isArray(value.scenes) ||
    value.scenes.length < 1 ||
    value.scenes.length > 40 ||
    !Array.isArray(value.words)
  )
    return false;

  let nextChar = 0;
  let previousSceneStart = -1;
  const scenes = new Map<number, Record<string, unknown>>();
  for (const [offset, sceneValue] of value.scenes.entries()) {
    if (
      !isRecord(sceneValue) ||
      !hasExactKeys(sceneValue, [
        "index",
        "fromChar",
        "toChar",
        "startMs",
        "endMs",
        "sourceAssetId",
        "sourceAssetChecksum",
      ])
    )
      return false;
    if (
      sceneValue.index !== offset + 1 ||
      sceneValue.fromChar !== nextChar ||
      !isInteger(sceneValue.toChar) ||
      sceneValue.toChar <= sceneValue.fromChar ||
      !isInteger(sceneValue.startMs) ||
      sceneValue.startMs < previousSceneStart ||
      !isInteger(sceneValue.endMs) ||
      sceneValue.endMs <= sceneValue.startMs ||
      sceneValue.endMs > value.durationMs ||
      !isNonEmptyString(sceneValue.sourceAssetId) ||
      !isChecksum(sceneValue.sourceAssetChecksum)
    )
      return false;
    nextChar = sceneValue.toChar;
    previousSceneStart = sceneValue.startMs;
    scenes.set(sceneValue.index as number, sceneValue);
  }
  if (nextChar !== value.scriptLength) return false;

  let previousWordStart = -1;
  let allWordsAligned = value.words.length > 0;
  for (const wordValue of value.words) {
    if (
      !isRecord(wordValue) ||
      !hasExactKeys(wordValue, ["text", "startMs", "endMs", "sceneIndex"], ["fromChar", "toChar"])
    )
      return false;
    const scene = scenes.get(wordValue.sceneIndex as number);
    if (
      !isNonEmptyString(wordValue.text) ||
      !isInteger(wordValue.startMs) ||
      wordValue.startMs < previousWordStart ||
      !isInteger(wordValue.endMs) ||
      wordValue.endMs <= wordValue.startMs ||
      wordValue.endMs > value.durationMs ||
      !scene ||
      wordValue.startMs < (scene.startMs as number) ||
      wordValue.endMs > (scene.endMs as number)
    )
      return false;
    const hasFrom = Object.hasOwn(wordValue, "fromChar");
    const hasTo = Object.hasOwn(wordValue, "toChar");
    if (hasFrom !== hasTo) return false;
    if (hasFrom) {
      if (
        !isInteger(wordValue.fromChar) ||
        !isInteger(wordValue.toChar) ||
        wordValue.fromChar < (scene.fromChar as number) ||
        wordValue.toChar <= wordValue.fromChar ||
        wordValue.toChar > (scene.toChar as number)
      )
        return false;
    } else {
      allWordsAligned = false;
    }
    previousWordStart = wordValue.startMs;
  }

  const expectedStatus =
    value.words.length === 0 ? "scene_only" : allWordsAligned ? "aligned" : "partial";
  if (value.alignmentStatus !== expectedStatus) return false;

  const { manifestChecksum, ...payload } = value as unknown as RenderTimingManifest;
  return calculateChecksum(payload) === manifestChecksum;
};

export const buildRenderTimingManifest = (
  input: RenderTimingManifestInput,
): RenderTimingManifest => {
  const words = input.words.map((word) => ({
    text: word.text,
    ...(word.fromChar !== undefined ? { fromChar: word.fromChar } : {}),
    ...(word.toChar !== undefined ? { toChar: word.toChar } : {}),
    startMs: word.startMs,
    endMs: word.endMs,
    sceneIndex: word.sceneIndex,
  }));
  const payload = {
    version: 1 as const,
    workspaceId: input.workspaceId,
    renderId: input.renderId,
    storyboardId: input.storyboardId,
    storyboardChecksum: input.storyboardChecksum,
    scriptId: input.scriptId,
    scriptChecksum: input.scriptChecksum,
    scriptLength: input.scriptLength,
    renderedAssetId: input.renderedAssetId,
    renderedAssetChecksum: input.renderedAssetChecksum,
    rendererVersion: input.rendererVersion,
    alignmentVersion: 1 as const,
    alignmentStatus:
      words.length === 0
        ? ("scene_only" as const)
        : words.every((word) => word.fromChar !== undefined && word.toChar !== undefined)
          ? ("aligned" as const)
          : ("partial" as const),
    durationMs: input.durationMs,
    audioTimelineOffsetMs: input.audioTimelineOffsetMs,
    measuredAt: input.measuredAt,
    scenes: input.scenes.map((scene) => ({ ...scene })),
    words,
  };
  const manifest: RenderTimingManifest = {
    ...payload,
    manifestChecksum: calculateChecksum(payload),
  };
  if (!validateManifest(manifest)) return invalid();
  if (serializedSize(manifest) > maxSerializedBytes)
    throw new Error("long_form_timing_manifest_too_large");
  return manifest;
};

export const parseRenderTimingManifest = (value: unknown): RenderTimingManifest | undefined => {
  if (value === null || value === undefined) return undefined;
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return invalid();
  }
  if (size > maxSerializedBytes) throw new Error("long_form_timing_manifest_too_large");
  if (!validateManifest(value)) return invalid();
  return value;
};
