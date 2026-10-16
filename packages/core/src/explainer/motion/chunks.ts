import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { MotionPlan } from "./plan.js";

/**
 * Chunked rendering of long stickman_motion plans. A frame is a pure function of (plan, t), so a
 * chunk is just a frame range of the one plan: transitions that overlap a seam are composed from
 * the same plan clock on both sides and need no special handling, and timing, words and captions
 * are untouched because nothing but the frame loop is split.
 *
 * Chunks are cut on scene boundaries and sized by duration (not by chapter: the plan carries no
 * chapters, and a chapter can be minutes long) so each chunk is bounded work, cache size and
 * timeout exposure.
 */
export const CHUNK_TARGET_MS = 60_000;
/** Plans at or under this length render in one pass, exactly as before. */
export const CHUNK_MIN_TOTAL_MS = 120_000;
/** Bump when the chunk encoder settings or frame ranges change meaning. */
export const CHUNK_FORMAT_VERSION = 1;

export type RenderChunk = Readonly<{
  index: number;
  /** First scene whose start opens this chunk, and the last scene starting inside it (plan.scenes positions). */
  sceneFrom: number;
  sceneTo: number;
  /** Frame range [startFrame, endFrame). */
  startFrame: number;
  endFrame: number;
}>;

export type ChunkOptions = Readonly<{ targetMs?: number; minTotalMs?: number }>;

export const frameCount = (plan: MotionPlan): number =>
  Math.ceil((plan.durationMs / 1000) * plan.fps);

/** Contiguous, gap-free frame ranges; a single chunk when the plan is short. */
export const planChunks = (
  plan: MotionPlan,
  options: ChunkOptions = {},
): readonly RenderChunk[] => {
  const targetMs = options.targetMs ?? CHUNK_TARGET_MS;
  const minTotalMs = options.minTotalMs ?? CHUNK_MIN_TOTAL_MS;
  const total = frameCount(plan);
  const whole: RenderChunk = {
    index: 0,
    sceneFrom: 0,
    sceneTo: Math.max(0, plan.scenes.length - 1),
    startFrame: 0,
    endFrame: total,
  };
  if (plan.durationMs <= minTotalMs || plan.scenes.length < 2) return [whole];
  const chunks: RenderChunk[] = [];
  let first = 0;
  let from = 0;
  for (let i = 1; i <= plan.scenes.length; i += 1) {
    const next = plan.scenes[i];
    const opened = plan.scenes[first]?.startMs ?? 0;
    // Close the chunk when the next scene would start at least targetMs after this one opened.
    if (next && next.startMs - opened < targetMs) continue;
    const endFrame = next ? Math.min(total, Math.ceil((next.startMs * plan.fps) / 1000)) : total;
    if (endFrame > from) {
      chunks.push({
        index: chunks.length,
        sceneFrom: first,
        sceneTo: i - 1,
        startFrame: from,
        endFrame,
      });
      from = endFrame;
    }
    first = i;
  }
  return chunks.length > 0 ? chunks : [whole];
};

/**
 * Identity of a chunk's video: a hash of everything its frames depend on. The scenes that overlap
 * the chunk's time range are hashed whole (spec, timing, words, art), so a changed neighbour that
 * shows through a seam transition changes the key; `sourceKey` (the storyboard checksum) and the
 * renderer version version the rest. Voice enters through the words and voice timing in the plan.
 */
export const chunkIdentity = (input: {
  plan: MotionPlan;
  chunk: RenderChunk;
  sourceKey: string;
  rendererVersion: number;
  /** The running build (release sha): a code change must not reuse chunks rendered by older code. */
  codeVersion: string;
  width: number;
  height: number;
  layerCache: boolean;
}): string => {
  const { plan, chunk } = input;
  const t0 = (chunk.startFrame * 1000) / plan.fps;
  const t1 = (chunk.endFrame * 1000) / plan.fps;
  const {
    scenes: _scenes,
    sfx: _sfx,
    plannedSilence: _s,
    plannedDark: _d,
    notes: _n,
    ...style
  } = plan;
  return createHash("sha256")
    .update(
      canonicalJson({
        format: CHUNK_FORMAT_VERSION,
        sourceKey: input.sourceKey,
        rendererVersion: input.rendererVersion,
        codeVersion: input.codeVersion,
        size: [input.width, input.height],
        layerCache: input.layerCache,
        frames: [chunk.startFrame, chunk.endFrame],
        sceneRange: [chunk.sceneFrom, chunk.sceneTo],
        style: { ...style, durationMs: undefined },
        scenes: plan.scenes.filter((scene) => scene.endMs > t0 && scene.startMs < t1),
      }),
      "utf8",
    )
    .digest("hex");
};

/** Returns the stored chunk video for `identity`, or runs `produce` and keeps its bytes. */
export type ChunkCache = (
  identity: string,
  produce: () => Promise<Uint8Array>,
) => Promise<Uint8Array>;
