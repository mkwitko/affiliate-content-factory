import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { buildRenderTimingManifest, parseRenderTimingManifest } from "./render-timing-manifest.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const checksum = "a".repeat(64);
const input = () => ({
  workspaceId,
  renderId: "render-1",
  storyboardId: "storyboard-1",
  storyboardChecksum: checksum,
  scriptId: "script-1",
  scriptChecksum: checksum,
  scriptLength: 11,
  renderedAssetId: "video-1",
  renderedAssetChecksum: "b".repeat(64),
  rendererVersion: 1,
  durationMs: 2500,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-26T12:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 11,
      startMs: 0,
      endMs: 2500,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "c".repeat(64),
    },
  ],
  words: [
    { text: "Hello", fromChar: 0, toChar: 5, startMs: 100, endMs: 700, sceneIndex: 1 },
    { text: "world", fromChar: 6, toChar: 11, startMs: 800, endMs: 1400, sceneIndex: 1 },
  ],
});

describe("render timing manifest", () => {
  it("builds a checksummed manifest bound to script, storyboard, source assets and output asset", () => {
    const manifest = buildRenderTimingManifest(input());

    expect(manifest).toMatchObject({
      version: 1,
      alignmentVersion: 1,
      workspaceId,
      renderId: "render-1",
      storyboardId: "storyboard-1",
      storyboardChecksum: checksum,
      scriptId: "script-1",
      scriptChecksum: checksum,
      renderedAssetId: "video-1",
      renderedAssetChecksum: "b".repeat(64),
      alignmentStatus: "aligned",
      durationMs: 2500,
    });
    expect(parseRenderTimingManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("preserves timed words without character offsets when word alignment is partial", () => {
    const manifest = buildRenderTimingManifest({
      ...input(),
      words: [{ text: "Hello!", startMs: 100, endMs: 700, sceneIndex: 1 }],
    });

    expect(manifest.alignmentStatus).toBe("partial");
    expect(manifest.words).toEqual([{ text: "Hello!", startMs: 100, endMs: 700, sceneIndex: 1 }]);
  });

  it("rejects non-monotonic, out-of-duration, cross-scene and incomplete scene ranges", () => {
    expect(() =>
      buildRenderTimingManifest({
        ...input(),
        words: [
          { text: "world", startMs: 800, endMs: 1400, sceneIndex: 1 },
          { text: "Hello", startMs: 100, endMs: 700, sceneIndex: 1 },
        ],
      }),
    ).toThrow("long_form_timing_manifest_invalid");
    expect(() =>
      buildRenderTimingManifest({
        ...input(),
        words: [{ text: "late", startMs: 2400, endMs: 2600, sceneIndex: 1 }],
      }),
    ).toThrow("long_form_timing_manifest_invalid");
    expect(() =>
      buildRenderTimingManifest({
        ...input(),
        scenes: input().scenes.map((scene) => ({ ...scene, fromChar: 1 })),
      }),
    ).toThrow("long_form_timing_manifest_invalid");
    expect(() =>
      buildRenderTimingManifest({
        ...input(),
        words: [{ text: "wrong scene", startMs: 100, endMs: 700, sceneIndex: 2 }],
      }),
    ).toThrow("long_form_timing_manifest_invalid");
  });

  it("rejects a corrupted checksum, malformed JSON value and manifest over 2 MiB", () => {
    const manifest = buildRenderTimingManifest(input());

    expect(() => parseRenderTimingManifest({ ...manifest, durationMs: 2000 })).toThrow(
      "long_form_timing_manifest_invalid",
    );
    expect(() => parseRenderTimingManifest("not-json-object")).toThrow(
      "long_form_timing_manifest_invalid",
    );
    expect(() =>
      buildRenderTimingManifest({
        ...input(),
        words: [{ text: "x".repeat(2 * 1024 * 1024), startMs: 0, endMs: 1, sceneIndex: 1 }],
      }),
    ).toThrow("long_form_timing_manifest_too_large");
  });

  it("returns undefined for legacy null timing manifests", () => {
    expect(parseRenderTimingManifest(null)).toBeUndefined();
    expect(parseRenderTimingManifest(undefined)).toBeUndefined();
  });
});
