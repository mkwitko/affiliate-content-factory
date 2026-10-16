import { parseWorkspaceId } from "@money-maker/contracts";
import { buildRenderTimingManifest } from "./render-timing-manifest.js";
import { describe, expect, it } from "vitest";
import { buildOwnedClipCaptionWords } from "./owned-clip-captions.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const manifest = buildRenderTimingManifest({
  workspaceId,
  renderId: "render-1",
  storyboardId: "story-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: "script-1",
  scriptChecksum: "b".repeat(64),
  scriptLength: 10,
  renderedAssetId: "asset-1",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 2000,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-28T00:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 10,
      startMs: 0,
      endMs: 2000,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "d".repeat(64),
    },
  ],
  words: [
    { text: "The", fromChar: 0, toChar: 3, startMs: 1000, endMs: 1200, sceneIndex: 1 },
    { text: "answer", fromChar: 4, toChar: 10, startMs: 1300, endMs: 1800, sceneIndex: 1 },
  ],
});

describe("buildOwnedClipCaptionWords", () => {
  it("maps aligned source words into clip-relative time and trims to the clip interval", () => {
    expect(buildOwnedClipCaptionWords({ manifest, startMs: 1100, endMs: 1500 })).toEqual([
      { text: "The", startMs: 0, endMs: 100 },
      { text: "answer", startMs: 200, endMs: 400 },
    ]);
  });

  it("returns null unless the source timing is fully aligned", () => {
    expect(
      buildOwnedClipCaptionWords({
        manifest: { ...manifest, alignmentStatus: "partial" },
        startMs: 900,
        endMs: 1900,
      }),
    ).toBeNull();
  });

  it("returns no captions when the selected interval contains no timed words", () => {
    expect(buildOwnedClipCaptionWords({ manifest, startMs: 100, endMs: 500 })).toEqual([]);
  });
});
