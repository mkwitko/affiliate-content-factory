import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createChannel,
  isManualOnlyChannelKind,
  isManualPublicationChannelKind,
  isPublishableChannelKind,
  manualPublicationChannelKinds,
  publishableChannelKinds,
} from "./channel.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const connection = (status: "active" | "revoked" = "active", targetWorkspaceId = workspaceId) => ({
  id: "connection-1",
  workspaceId: targetWorkspaceId,
  provider: "post_for_me" as const,
  mode: "api_key" as const,
  secretReference: "secret://workspace/connection-1",
  accountId: "default",
  status,
});

describe("channel domain", () => {
  it("rejects an inactive or cross-workspace provider connection", () => {
    expect(() =>
      createChannel({ workspaceId, connection: connection("revoked"), kind: "threads" }),
    ).toThrow("Connection is not active");
    expect(() =>
      createChannel({
        workspaceId,
        connection: connection("active", otherWorkspaceId),
        kind: "threads",
      }),
    ).toThrow("Connection belongs to another workspace");
  });

  it("derives stable capabilities for a supported channel kind", () => {
    const channel = createChannel({
      id: "channel-1",
      workspaceId,
      connection: connection(),
      kind: "instagram_carousel",
      label: "Instagram feed",
    });

    expect(channel).toMatchObject({
      id: "channel-1",
      workspaceId,
      connectionId: "connection-1",
      status: "active",
    });
    expect(channel.capabilities).toEqual(
      expect.objectContaining({
        maxAssets: 10,
        requiresOrderedAssets: true,
        requiredAssetDimensions: { width: 1080, height: 1350 },
      }),
    );
  });

  it("lets Threads carry one optional image", () => {
    const channel = createChannel({ workspaceId, connection: connection(), kind: "threads" });
    expect(channel.capabilities).toMatchObject({
      maxAssets: 1,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    expect(channel.capabilities.requiredAssetDimensions).toBeUndefined();
  });
});

describe("publishable channel kinds", () => {
  it("lists exactly the kinds the publisher maps", () => {
    expect([...publishableChannelKinds]).toEqual([
      "instagram_carousel",
      "instagram_stories",
      "instagram_reels",
      "threads",
      "youtube",
      "tiktok_video",
      "tiktok_photo_post",
    ]);
    expect(isPublishableChannelKind("tiktok_photo_post")).toBe(true);
    expect(isPublishableChannelKind("threads")).toBe(true);
    expect(isPublishableChannelKind("instagram_reels")).toBe(true);
    expect(isPublishableChannelKind("youtube")).toBe(true);
    expect(isPublishableChannelKind("tiktok_video")).toBe(true);
  });
});

describe("manual publication channel kinds", () => {
  it("lets the operator record hand-made Stories and TikTok posts", () => {
    expect([...manualPublicationChannelKinds]).toEqual([
      "instagram_stories",
      "tiktok_video",
      "tiktok_photo_post",
    ]);
    expect(isManualPublicationChannelKind("instagram_stories")).toBe(true);
    expect(isManualPublicationChannelKind("tiktok_video")).toBe(true);
    expect(isManualPublicationChannelKind("tiktok_photo_post")).toBe(true);
    expect(isManualPublicationChannelKind("threads")).toBe(false);
    expect(isManualPublicationChannelKind("youtube")).toBe(false);
  });

  it("keeps only Instagram Stories manual-only; TikTok goes to the app's drafts", () => {
    expect(isManualOnlyChannelKind("instagram_stories")).toBe(true);
    expect(isManualOnlyChannelKind("tiktok_video")).toBe(false);
    expect(isManualOnlyChannelKind("tiktok_photo_post")).toBe(false);
  });
});

describe("instagram_reels capabilities", () => {
  it("takes exactly one 1080x1920 mp4 asset", () => {
    const channel = createChannel({
      workspaceId,
      connection: connection(),
      kind: "instagram_reels",
    });
    expect(channel.capabilities).toEqual({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: ["video/mp4"],
      captionMaxLength: 2200,
      requiredAssetDimensions: { width: 1080, height: 1920 },
    });
  });
});

describe("tiktok_video capabilities", () => {
  it("takes exactly one 1080x1920 mp4 asset", () => {
    const channel = createChannel({
      workspaceId,
      connection: connection(),
      kind: "tiktok_video",
    });
    expect(channel.capabilities).toEqual({
      maxAssets: 1,
      requiresOrderedAssets: false,
      allowedMimeTypes: ["video/mp4"],
      captionMaxLength: 2200,
      requiredAssetDimensions: { width: 1080, height: 1920 },
    });
  });
});
