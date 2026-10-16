import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderStats, TimeRange } from "@money-maker/core/publishing/render-quality";
import { RENDER_TEMP_PREFIX } from "./ffmpeg-reel-renderer.js";
import { measureRenderedVideo } from "./video-quality-probe.js";

/** Spec 4.5: container, size (provider tiers allowed), duration within this tolerance, and black/freeze via render QA. */
const DURATION_TOLERANCE_MS = 1000;
/** A clip that is black or frozen for this share of its length is unusable. */
const DEGENERATE_SHARE = 0.9;

export type ClipExpectation = Readonly<{ width: number; height: number; seconds: number }>;
export type ClipCheckVerdict = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

/**
 * The provider snaps sizes to its own tiers (768x1152 came back 832x1088 in the A0 spike), and the
 * renderer cover-crops every clip to the canvas. Accept the same orientation with each side at
 * least 90% of the request; a landscape container for a portrait request still fails.
 */
const MIN_SIDE_SHARE = 0.9;
const sizeAcceptable = (
  video: Readonly<{ width: number; height: number }>,
  expected: ClipExpectation,
): boolean =>
  video.height > video.width === expected.height > expected.width &&
  video.width >= expected.width * MIN_SIDE_SHARE &&
  video.height >= expected.height * MIN_SIDE_SHARE;

const coveredMs = (ranges: readonly TimeRange[]): number =>
  ranges.reduce((sum, range) => sum + Math.max(0, range.endMs - range.startMs), 0);

/** Pure: grades what ffprobe measured. Orientation cannot be read from pixels (spec 4.5). */
export const evaluateClipStats = (
  stats: RenderStats,
  expected: ClipExpectation,
): ClipCheckVerdict => {
  if (!stats.readable) return { ok: false, reason: "unreadable" };
  if (!stats.video) return { ok: false, reason: "no_video" };
  if (stats.decodeErrors > 0) return { ok: false, reason: "decode_errors" };
  if (!sizeAcceptable(stats.video, expected))
    return { ok: false, reason: `dimensions_mismatch:${stats.video.width}x${stats.video.height}` };
  if (Math.abs(stats.durationMs - expected.seconds * 1000) > DURATION_TOLERANCE_MS)
    return { ok: false, reason: "duration_mismatch" };
  if (coveredMs(stats.blacks) >= stats.durationMs * DEGENERATE_SHARE)
    return { ok: false, reason: "black_clip" };
  if (coveredMs(stats.freezes) >= stats.durationMs * DEGENERATE_SHARE)
    return { ok: false, reason: "frozen_clip" };
  return { ok: true };
};

/** Writes the clip to a temporary file, measures it with the render-QA probe and grades it. */
export const checkSceneClip = async (
  bytes: Uint8Array,
  expected: ClipExpectation,
  options: Readonly<{ signal?: AbortSignal | undefined; tmpRoot?: string }> = {},
): Promise<ClipCheckVerdict> => {
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `${RENDER_TEMP_PREFIX}clip-`));
  try {
    const path = join(dir, "clip.mp4");
    await writeFile(path, bytes);
    return evaluateClipStats(
      await measureRenderedVideo(path, { signal: options.signal }),
      expected,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
