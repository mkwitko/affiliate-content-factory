import { describe, expect, it, vi } from "vitest";
import { createYouTubeDataApiClient } from "./data-api-client.js";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("YouTube Data API discovery client", () => {
  it("batches public video/channel metadata and only filters rights metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: { videoId: "abcdefghijk" },
              snippet: {
                title: "Video",
                channelId: "UCabcdefghijklmnopqrstuv",
                channelTitle: "Channel",
                publishedAt: "2026-09-01T00:00:00Z",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "abcdefghijk",
              snippet: { defaultLanguage: "pt" },
              contentDetails: { duration: "PT2M3S", caption: "true" },
              statistics: { viewCount: "1200" },
              status: { license: "creativeCommon" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: "UCabcdefghijklmnopqrstuv", statistics: { subscriberCount: "3000" } }],
        }),
      );
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });

    const result = await client.searchVideos({
      query: "educação financeira",
      regionCode: "BR",
      relevanceLanguage: "pt",
      license: "creativeCommon",
      limit: 5,
    });

    expect(result[0]).toMatchObject({
      videoId: "abcdefghijk",
      durationSeconds: 123,
      viewCount: 1200,
      license: "creativeCommon",
      captionsAvailable: true,
      subscriberCount: 3000,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("videoLicense=creativeCommon");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("regionCode=BR");
  });

  it("does not send requests for an empty result and maps provider errors without payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ items: [] }));
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });
    expect(await client.searchVideos({ query: "test", limit: 5 })).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const failed = createYouTubeDataApiClient({
      apiKey: "test-key",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ error: "private payload" }, 403)),
    });
    await expect(failed.searchVideos({ query: "test", limit: 5 })).rejects.toThrow(
      "youtube_data_api_http_403",
    );
  });

  it("resolves one video by id using only fixed YouTube metadata endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "abcdefghijk",
              snippet: {
                title: "Supplied video",
                channelId: "UCabcdefghijklmnopqrstuv",
                channelTitle: "Channel",
                publishedAt: "2026-09-01T00:00:00Z",
                defaultLanguage: "pt",
              },
              contentDetails: { duration: "PT42M", caption: "false" },
              statistics: { viewCount: "900" },
              status: { license: "youtube" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: "UCabcdefghijklmnopqrstuv", statistics: { subscriberCount: "300" } }],
        }),
      );
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });

    await expect(client.getVideo("abcdefghijk")).resolves.toMatchObject({
      videoId: "abcdefghijk",
      title: "Supplied video",
      durationSeconds: 2520,
      captionsAvailable: false,
      viewCount: 900,
      subscriberCount: 300,
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "https://www.googleapis.com/youtube/v3/videos?",
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("id=abcdefghijk");
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("youtube.com/watch");
  });

  it("does not request metadata for an invalid video id and returns null for a missing video", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ items: [] }));
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });
    await expect(client.getVideo("not-a-video-id")).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.getVideo("abcdefghijk")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves a channel handle to its recent uploads without fetching media", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "UCabcdefghijklmnopqrstuv",
              snippet: { title: "Creator" },
              statistics: { subscriberCount: "500" },
              contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              snippet: {
                title: "Recent video",
                publishedAt: "2026-09-01T00:00:00Z",
                resourceId: { videoId: "abcdefghijk" },
              },
              contentDetails: { videoPublishedAt: "2026-09-01T00:00:00Z" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "abcdefghijk",
              snippet: {
                title: "Recent video",
                channelId: "UCabcdefghijklmnopqrstuv",
                channelTitle: "Creator",
                publishedAt: "2026-09-01T00:00:00Z",
              },
              contentDetails: { duration: "PT12M", caption: "false" },
              statistics: { viewCount: "1000" },
              status: { license: "youtube" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: "UCabcdefghijklmnopqrstuv", statistics: { subscriberCount: "500" } }],
        }),
      );
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });

    await expect(
      client.getCollection({ kind: "channel", id: "creator.handle", lookup: "handle", limit: 5 }),
    ).resolves.toMatchObject({
      kind: "channel",
      title: "Creator",
      videos: [
        { videoId: "abcdefghijk", durationSeconds: 720, viewCount: 1000, subscriberCount: 500 },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("forHandle=creator.handle");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("playlistItems?");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("maxResults=5");
  });

  it("resolves a playlist and preserves its item order in public metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ items: [{ id: "PL1234567890", snippet: { title: "Useful talks" } }] }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              snippet: {
                title: "First video",
                videoOwnerChannelId: "UCabcdefghijklmnopqrstuv",
                videoOwnerChannelTitle: "Creator",
                resourceId: { videoId: "abcdefghijk" },
              },
              contentDetails: { videoPublishedAt: "2026-09-01T00:00:00Z" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "abcdefghijk",
              snippet: {
                title: "First video",
                channelId: "UCabcdefghijklmnopqrstuv",
                channelTitle: "Creator",
                publishedAt: "2026-09-01T00:00:00Z",
              },
              contentDetails: { duration: "PT20M", caption: "true" },
              statistics: { viewCount: "1200" },
              status: { license: "youtube" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: "UCabcdefghijklmnopqrstuv", statistics: { subscriberCount: "500" } }],
        }),
      );
    const client = createYouTubeDataApiClient({ apiKey: "test-key", fetcher });

    await expect(
      client.getCollection({ kind: "playlist", id: "PL1234567890", lookup: "id", limit: 3 }),
    ).resolves.toMatchObject({
      kind: "playlist",
      title: "Useful talks",
      videos: [{ videoId: "abcdefghijk", title: "First video", subscriberCount: 500 }],
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("playlists?");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("playlistId=PL1234567890");
  });
});
