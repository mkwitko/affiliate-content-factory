import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { refineOwnedClipBoundaries, refineOwnedClipTimeRange } from "./owned-clip-boundaries.js";
import { buildRenderTimingManifest } from "./render-timing-manifest.js";

const manifest = buildRenderTimingManifest({
  workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
  renderId: "render-1",
  storyboardId: "board-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: "script-1",
  scriptChecksum: "b".repeat(64),
  scriptLength: 22,
  renderedAssetId: "asset-1",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 10_000,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-26T12:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 22,
      startMs: 0,
      endMs: 10_000,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "d".repeat(64),
    },
  ],
  words: [
    { text: "Here", fromChar: 0, toChar: 4, startMs: 1000, endMs: 1300, sceneIndex: 1 },
    { text: "is", fromChar: 5, toChar: 7, startMs: 1350, endMs: 1500, sceneIndex: 1 },
    { text: "the", fromChar: 8, toChar: 11, startMs: 1550, endMs: 1800, sceneIndex: 1 },
    { text: "answer", fromChar: 12, toChar: 18, startMs: 1900, endMs: 2400, sceneIndex: 1 },
    { text: "now", fromChar: 19, toChar: 22, startMs: 2700, endMs: 3000, sceneIndex: 1 },
  ],
});

describe("refineOwnedClipBoundaries", () => {
  it("maps a semantic script span to complete timed words with bounded context", () => {
    expect(refineOwnedClipBoundaries({ manifest, fromChar: 8, toChar: 18 })).toEqual({
      startMs: 1550,
      endMs: 2650,
      durationMs: 1100,
      fromChar: 8,
      toChar: 18,
      firstWord: "the",
      lastWord: "answer",
      alignmentStatus: "aligned",
      boundaryBasis: ["word", "speech_gap"],
    });
  });

  it("rejects ambiguous offsets, empty spans, and clips longer than three minutes", () => {
    expect(() => refineOwnedClipBoundaries({ manifest, fromChar: 7, toChar: 8 })).toThrow(
      "clip_semantic_span_unmatched",
    );
    expect(() => refineOwnedClipBoundaries({ manifest, fromChar: 18, toChar: 18 })).toThrow(
      "clip_semantic_span_invalid",
    );
    const longManifest = buildRenderTimingManifest({
      workspaceId: manifest.workspaceId,
      renderId: manifest.renderId,
      storyboardId: manifest.storyboardId,
      storyboardChecksum: manifest.storyboardChecksum,
      scriptId: manifest.scriptId,
      scriptChecksum: manifest.scriptChecksum,
      scriptLength: manifest.scriptLength,
      renderedAssetId: manifest.renderedAssetId,
      renderedAssetChecksum: manifest.renderedAssetChecksum,
      rendererVersion: manifest.rendererVersion,
      durationMs: 200_000,
      audioTimelineOffsetMs: 0,
      measuredAt: manifest.measuredAt,
      scenes: manifest.scenes.map((scene) => ({ ...scene, endMs: 200_000 })),
      words: [
        { text: "Here", fromChar: 0, toChar: 4, startMs: 1_000, endMs: 1_300, sceneIndex: 1 },
        {
          text: "answer",
          fromChar: 12,
          toChar: 18,
          startMs: 182_000,
          endMs: 182_500,
          sceneIndex: 1,
        },
      ],
    });
    expect(() =>
      refineOwnedClipBoundaries({ manifest: longManifest, fromChar: 0, toChar: 18 }),
    ).toThrow("clip_duration_invalid");
  });

  it("maps a manually selected time range to complete aligned words and context", () => {
    expect(refineOwnedClipTimeRange({ manifest, startMs: 1700, endMs: 2000 })).toMatchObject({
      startMs: 1550,
      endMs: 2650,
      fromChar: 8,
      toChar: 18,
      firstWord: "the",
      lastWord: "answer",
    });
  });

  it("rejects invalid, unaligned, and speech-free time ranges", () => {
    expect(() => refineOwnedClipTimeRange({ manifest, startMs: 4000, endMs: 3000 })).toThrow(
      "clip_time_range_invalid",
    );
    expect(() => refineOwnedClipTimeRange({ manifest, startMs: 4000, endMs: 5000 })).toThrow(
      "clip_semantic_span_unmatched",
    );
    const partialManifest = buildRenderTimingManifest({
      workspaceId: manifest.workspaceId,
      renderId: manifest.renderId,
      storyboardId: manifest.storyboardId,
      storyboardChecksum: manifest.storyboardChecksum,
      scriptId: manifest.scriptId,
      scriptChecksum: manifest.scriptChecksum,
      scriptLength: manifest.scriptLength,
      renderedAssetId: manifest.renderedAssetId,
      renderedAssetChecksum: manifest.renderedAssetChecksum,
      rendererVersion: manifest.rendererVersion,
      durationMs: manifest.durationMs,
      audioTimelineOffsetMs: manifest.audioTimelineOffsetMs,
      measuredAt: manifest.measuredAt,
      scenes: manifest.scenes,
      words: manifest.words.map(({ text, startMs, endMs, sceneIndex }) => ({
        text,
        startMs,
        endMs,
        sceneIndex,
      })),
    });
    expect(() =>
      refineOwnedClipTimeRange({ manifest: partialManifest, startMs: 1900, endMs: 2200 }),
    ).toThrow("clip_timing_unavailable");
  });
});
