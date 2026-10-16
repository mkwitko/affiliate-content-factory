import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import { validateYouTubeVariant, youtubeThumbnailIsRecommended } from "./youtube-validation.js";
import type { YouTubePublishSpecV1 } from "./youtube-publish-spec.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const video: Asset = {
  id: "video-1",
  workspaceId,
  objectKey: "video",
  checksum: "a".repeat(64),
  byteSize: 1000,
  durationMs: 180_000,
  mimeType: "video/mp4",
  width: 1080,
  height: 1920,
  provenance: "generated",
  license: "test",
  commercialUse: true,
  state: "active",
};
const spec: YouTubePublishSpecV1 = {
  schemaVersion: 1,
  title: "A useful video",
  intendedFormat: "short",
  privacyStatus: "private",
  madeForKids: false,
  containsSyntheticMedia: false,
};

describe("YouTube variant validation", () => {
  it("accepts one active vertical MP4 at the three-minute Short limit", () => {
    expect(
      validateYouTubeVariant({
        spec,
        asset: video,
        thumbnail: undefined,
        assetIds: [video.id],
        workspaceId,
        caption: "Description",
      }),
    ).toBeNull();
  });

  it("requires known duration and rejects non-vertical or overlong Shorts", () => {
    expect(
      validateYouTubeVariant({
        spec,
        asset: (({ durationMs: _durationMs, ...withoutDuration }) => withoutDuration)(video),
        thumbnail: undefined,
        assetIds: [video.id],
        workspaceId,
        caption: "Description",
      }),
    ).toBe("asset_duration_unknown");
    expect(
      validateYouTubeVariant({
        spec,
        asset: { ...video, width: 1920, height: 1080 },
        thumbnail: undefined,
        assetIds: [video.id],
        workspaceId,
        caption: "Description",
      }),
    ).toBe("short_format_invalid");
  });

  it("requires synthetic-media disclosure and a separate valid thumbnail", () => {
    expect(
      validateYouTubeVariant({
        spec: { ...spec, containsSyntheticMedia: true },
        asset: video,
        thumbnail: undefined,
        assetIds: [video.id],
        workspaceId,
        caption: "Description",
      }),
    ).toBe("publish_spec_invalid");
    expect(
      validateYouTubeVariant({
        spec: { ...spec, thumbnailAssetId: video.id },
        asset: video,
        thumbnail: video,
        assetIds: [video.id],
        workspaceId,
        caption: "Description",
      }),
    ).toBe("thumbnail_invalid");
  });

  it("warns when the separate thumbnail misses recommended dimensions or size", () => {
    expect(
      youtubeThumbnailIsRecommended({
        ...video,
        id: "thumb",
        mimeType: "image/jpeg",
        width: 1280,
        height: 720,
        byteSize: 2_000_001,
      }),
    ).toBe(false);
    expect(
      youtubeThumbnailIsRecommended({
        ...video,
        id: "thumb",
        mimeType: "image/jpeg",
        width: 1280,
        height: 720,
        byteSize: 2_000_000,
      }),
    ).toBe(true);
  });
});
