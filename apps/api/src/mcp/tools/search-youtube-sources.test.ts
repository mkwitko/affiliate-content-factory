import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { searchYouTubeSourcesTool } from "./search-youtube-sources.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

describe("search_youtube_sources", () => {
  it("returns dated public metadata and clearly marks rights as unverified", async () => {
    const searchVideos = vi.fn(async () => [
      {
        videoId: "abcdefghijk",
        title: "Research source",
        channelId: "UC1",
        channelTitle: "Channel",
        publishedAt: "2026-09-01T00:00:00Z",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
        durationSeconds: 80,
        viewCount: 2000,
        license: "creativeCommon" as const,
        captionsAvailable: true,
        defaultLanguage: "pt",
        channelUrl: "https://www.youtube.com/channel/UC1",
        subscriberCount: 300,
      },
    ]);
    const deps = {
      workspaces: {
        findMembership: async () => ({ workspaceId, userId, role: "owner", status: "active" }),
      },
      youtubeSourceDiscovery: { searchVideos },
    } as unknown as McpDependencies;

    const result = await searchYouTubeSourcesTool(
      { workspaceId, query: "organização da casa", license: "creativeCommon" },
      userId,
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        rightsNotice: expect.stringContaining("not permission"),
        videos: [{ videoId: "abcdefghijk", license: "creativeCommon", viewCount: 2000 }],
      },
    });
    expect(searchVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "organização da casa",
        license: "creativeCommon",
        limit: 10,
      }),
    );
  });

  it("fails closed without a configured provider and rejects invalid queries", async () => {
    const deps = {
      workspaces: {
        findMembership: async () => ({ workspaceId, userId, role: "owner", status: "active" }),
      },
    } as unknown as McpDependencies;
    expect(await searchYouTubeSourcesTool({ workspaceId, query: "x" }, userId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    expect(
      await searchYouTubeSourcesTool({ workspaceId, query: "valid topic" }, userId, deps),
    ).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });
});
