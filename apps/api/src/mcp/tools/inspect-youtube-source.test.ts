import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { YouTubeSourceVideo } from "@money-maker/core/research/youtube-discovery";
import type { McpDependencies } from "../server.js";
import { inspectYouTubeSourceTool } from "./inspect-youtube-source.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const dependencies = (
  getVideo: () => Promise<YouTubeSourceVideo | null> = vi.fn(async () => null),
  access = true,
  getCollection: () => Promise<unknown> = vi.fn(async () => null),
) =>
  ({
    workspaces: {
      findMembership: async () =>
        access ? { workspaceId, userId, role: "owner", status: "active" } : null,
    },
    youtubeSourceDiscovery: { getVideo, getCollection },
  }) as unknown as McpDependencies;

describe("inspect_youtube_source", () => {
  it("resolves a supplied video URL to ephemeral public metadata only", async () => {
    const getVideo = vi.fn(async () => ({
      videoId: "abcdefghijk",
      title: "Source title",
      channelId: "UC1",
      channelTitle: "Creator",
      publishedAt: "2026-09-01T00:00:00Z",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      durationSeconds: 2400,
      viewCount: 5000,
      license: "youtube" as const,
      captionsAvailable: true,
      defaultLanguage: "pt",
      channelUrl: "https://www.youtube.com/channel/UC1",
      subscriberCount: 200,
    }));
    const result = await inspectYouTubeSourceTool(
      { workspaceId, sourceUrl: "https://youtu.be/abcdefghijk?t=30" },
      userId,
      dependencies(getVideo),
    );

    expect(getVideo).toHaveBeenCalledWith("abcdefghijk");
    expect(result).toMatchObject({
      ok: true,
      value: {
        persisted: false,
        video: { videoId: "abcdefghijk", captionsAvailable: true },
        transcriptAvailable: false,
        mediaAvailable: false,
        rightsNotice: expect.stringContaining("permission to use"),
      },
    });
  });

  it("returns a bounded ephemeral shortlist for channel and playlist URLs", async () => {
    const collection = {
      kind: "channel" as const,
      id: "UCabcdefghijklmnopqrstuv",
      title: "Creator",
      url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      videos: [{ videoId: "abcdefghijk", title: "Recent video" }],
    };
    const getCollection = vi.fn(async () => collection);
    const result = await inspectYouTubeSourceTool(
      {
        workspaceId,
        sourceUrl: "https://youtube.com/@creatorhandle",
        limit: 5,
      },
      userId,
      dependencies(
        vi.fn(async () => null),
        true,
        getCollection,
      ),
    );

    expect(getCollection).toHaveBeenCalledWith({
      kind: "channel",
      id: "creatorhandle",
      lookup: "handle",
      limit: 5,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        persisted: false,
        collection: { kind: "channel", title: "Creator", videos: [{ videoId: "abcdefghijk" }] },
        transcriptAvailable: false,
        mediaAvailable: false,
      },
    });
  });

  it("rejects arbitrary URLs before provider access and requires workspace access", async () => {
    const getVideo = vi.fn(async () => null);
    await expect(
      inspectYouTubeSourceTool(
        { workspaceId, sourceUrl: "https://youtube.com.evil.test/watch?v=abcdefghijk" },
        userId,
        dependencies(getVideo),
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(getVideo).not.toHaveBeenCalled();

    await expect(
      inspectYouTubeSourceTool(
        { workspaceId, sourceUrl: "https://youtube.com/watch?v=abcdefghijk" },
        userId,
        dependencies(getVideo, false),
      ),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("provides a useful missing-source and provider-failure result", async () => {
    await expect(
      inspectYouTubeSourceTool(
        { workspaceId, sourceUrl: "https://youtube.com/watch?v=abcdefghijk" },
        userId,
        dependencies(),
      ),
    ).resolves.toEqual({ ok: false, error: "SOURCE_NOT_FOUND" });

    await expect(
      inspectYouTubeSourceTool(
        { workspaceId, sourceUrl: "https://youtube.com/watch?v=abcdefghijk" },
        userId,
        dependencies(vi.fn(async () => Promise.reject(new Error("provider down")))),
      ),
    ).resolves.toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });
});
