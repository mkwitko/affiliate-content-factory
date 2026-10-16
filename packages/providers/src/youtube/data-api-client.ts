import type {
  YouTubeSourceDiscovery,
  YouTubeSourceCollection,
  YouTubeSourceCollectionLookup,
  YouTubeSourceVideo,
  YouTubeVideoSearchInput,
} from "@money-maker/core/research/youtube-discovery";
import { parseYouTubeDurationSeconds } from "@money-maker/core/research/youtube-discovery";

const apiBase = "https://www.googleapis.com/youtube/v3/";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const nested = (value: RecordValue | null, key: string) => record(value?.[key]);
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

const parseSearchItem = (value: unknown) => {
  const item = record(value);
  const id = stringValue(nested(item, "id")?.videoId);
  const snippet = nested(item, "snippet");
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  const channelTitle = stringValue(snippet?.channelTitle);
  const publishedAt = stringValue(snippet?.publishedAt);
  if (
    !id ||
    !videoIdPattern.test(id) ||
    !title ||
    !channelId ||
    !channelTitle ||
    !publishedAt ||
    !Number.isFinite(Date.parse(publishedAt))
  )
    return null;
  return { id, title, channelId, channelTitle, publishedAt };
};

const parsePlaylistItem = (value: unknown) => {
  const item = record(value);
  const snippet = nested(item, "snippet");
  const content = nested(item, "contentDetails");
  const resource = nested(snippet, "resourceId");
  const id = stringValue(resource?.videoId) ?? stringValue(content?.videoId);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.videoOwnerChannelId) ?? "";
  const channelTitle = stringValue(snippet?.videoOwnerChannelTitle) ?? "";
  const publishedAt = stringValue(content?.videoPublishedAt) ?? stringValue(snippet?.publishedAt);
  if (
    !id ||
    !videoIdPattern.test(id) ||
    !title ||
    !publishedAt ||
    !Number.isFinite(Date.parse(publishedAt))
  )
    return null;
  return { id, title, channelId, channelTitle, publishedAt };
};
type ParsedPlaylistItem = NonNullable<ReturnType<typeof parsePlaylistItem>>;

const safeCount = (value: string | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const toSourceVideo = (
  value: RecordValue,
  subscribersByChannel: ReadonlyMap<string, number | null>,
  fallback?: Readonly<{
    id: string;
    title: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
  }>,
): YouTubeSourceVideo | null => {
  const videoId = stringValue(value.id) ?? fallback?.id;
  const snippet = nested(value, "snippet");
  const channelId = stringValue(snippet?.channelId) ?? fallback?.channelId;
  const channelTitle = stringValue(snippet?.channelTitle) ?? fallback?.channelTitle;
  const title = stringValue(snippet?.title) ?? fallback?.title;
  const publishedAt = stringValue(snippet?.publishedAt) ?? fallback?.publishedAt;
  if (
    !videoId ||
    !videoIdPattern.test(videoId) ||
    !channelId ||
    !channelTitle ||
    !title ||
    !publishedAt ||
    !Number.isFinite(Date.parse(publishedAt))
  )
    return null;
  const details = nested(value, "contentDetails");
  const statistics = nested(value, "statistics");
  const status = nested(value, "status");
  const duration = stringValue(details?.duration);
  const caption = stringValue(details?.caption);
  const license = stringValue(status?.license);
  return {
    videoId,
    title,
    channelId,
    channelTitle,
    publishedAt,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    durationSeconds: duration ? parseYouTubeDurationSeconds(duration) : null,
    viewCount: safeCount(stringValue(statistics?.viewCount)),
    license: license === "creativeCommon" || license === "youtube" ? license : "unknown",
    captionsAvailable: caption === "true" ? true : caption === "false" ? false : null,
    defaultLanguage: stringValue(snippet?.defaultLanguage) ?? null,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    subscriberCount: subscribersByChannel.get(channelId) ?? null,
  };
};

export const createYouTubeDataApiClient = (input: {
  apiKey: string;
  fetcher?: typeof fetch;
}): YouTubeSourceDiscovery => {
  const fetcher = input.fetcher ?? fetch;
  const request = async (path: string, params: URLSearchParams) => {
    params.set("key", input.apiKey);
    const response = await fetcher(new URL(`${path}?${params}`, apiBase), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`youtube_data_api_http_${response.status}`);
    const body = record(await response.json());
    if (!Array.isArray(body?.items)) throw new Error("youtube_data_api_response_invalid");
    return body.items;
  };

  const videosInPlaylist = async (playlistId: string, limit: number) => {
    const items = await request(
      "playlistItems",
      new URLSearchParams({
        part: "snippet,contentDetails",
        playlistId,
        maxResults: String(limit),
      }),
    );
    return items.flatMap((item) => {
      const parsed = parsePlaylistItem(item);
      return parsed ? [parsed] : [];
    });
  };

  const enrichCollectionVideos = async (
    entries: ParsedPlaylistItem[],
  ): Promise<readonly YouTubeSourceVideo[]> => {
    const videoIds = [...new Set(entries.map((entry) => entry.id))];
    if (videoIds.length === 0) return [];
    const channels = [...new Set(entries.map((entry) => entry.channelId).filter(Boolean))];
    const [videoItems, channelItems] = await Promise.all([
      request(
        "videos",
        new URLSearchParams({
          part: "snippet,contentDetails,statistics,status",
          id: videoIds.join(","),
        }),
      ),
      channels.length
        ? request("channels", new URLSearchParams({ part: "statistics", id: channels.join(",") }))
        : Promise.resolve([]),
    ]);
    const videosById = new Map(
      videoItems.flatMap((item) => {
        const value = record(item);
        const id = stringValue(value?.id);
        return id && videoIdPattern.test(id) ? [[id, value] as const] : [];
      }),
    );
    const subscribersByChannel = new Map(
      channelItems.flatMap((item) => {
        const value = record(item);
        const id = stringValue(value?.id);
        return id
          ? [[id, safeCount(stringValue(nested(value, "statistics")?.subscriberCount))] as const]
          : [];
      }),
    );
    return entries.flatMap((entry) => {
      const details = videosById.get(entry.id);
      if (!details) return [];
      const video = toSourceVideo(details, subscribersByChannel, entry);
      return video ? [video] : [];
    });
  };

  return {
    async searchVideos(search: YouTubeVideoSearchInput): Promise<readonly YouTubeSourceVideo[]> {
      const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        maxResults: String(Math.min(10, Math.max(1, search.limit))),
        q: search.query,
        order: search.order ?? "relevance",
      });
      if (search.regionCode) params.set("regionCode", search.regionCode);
      if (search.relevanceLanguage) params.set("relevanceLanguage", search.relevanceLanguage);
      if (search.publishedAfter) params.set("publishedAfter", search.publishedAfter);
      if (search.publishedBefore) params.set("publishedBefore", search.publishedBefore);
      if (search.license === "creativeCommon") params.set("videoLicense", search.license);
      const searchItems = (await request("search", params)).flatMap((item) => {
        const parsed = parseSearchItem(item);
        return parsed ? [parsed] : [];
      });
      const videoIds = [...new Set(searchItems.map((item) => item.id))];
      if (videoIds.length === 0) return [];
      const channels = [...new Set(searchItems.map((item) => item.channelId))];
      const [videoItems, channelItems] = await Promise.all([
        request(
          "videos",
          new URLSearchParams({
            part: "snippet,contentDetails,statistics,status",
            id: videoIds.join(","),
          }),
        ),
        request("channels", new URLSearchParams({ part: "statistics", id: channels.join(",") })),
      ]);
      const videosById = new Map(
        videoItems.flatMap((item) => {
          const value = record(item);
          const id = stringValue(value?.id);
          if (!id || !videoIdPattern.test(id)) return [];
          return [[id, value] as const];
        }),
      );
      const subscribersByChannel = new Map(
        channelItems.flatMap((item) => {
          const value = record(item);
          const id = stringValue(value?.id);
          if (!id) return [];
          return [
            [id, safeCount(stringValue(nested(value, "statistics")?.subscriberCount))] as const,
          ];
        }),
      );
      return searchItems.flatMap((item) => {
        const video = videosById.get(item.id);
        if (!video) return [];
        const mapped = toSourceVideo(video, subscribersByChannel, item);
        return mapped ? [mapped] : [];
      });
    },
    async getVideo(videoId: string): Promise<YouTubeSourceVideo | null> {
      if (!videoIdPattern.test(videoId)) return null;
      const items = await request(
        "videos",
        new URLSearchParams({ part: "snippet,contentDetails,statistics,status", id: videoId }),
      );
      const video = record(items[0]);
      if (!video) return null;
      const channelId = stringValue(nested(video, "snippet")?.channelId);
      if (!channelId) return null;
      const channelItems = await request(
        "channels",
        new URLSearchParams({ part: "statistics", id: channelId }),
      );
      const subscribersByChannel = new Map(
        channelItems.flatMap((item) => {
          const channel = record(item);
          const id = stringValue(channel?.id);
          return id
            ? [
                [
                  id,
                  safeCount(stringValue(nested(channel, "statistics")?.subscriberCount)),
                ] as const,
              ]
            : [];
        }),
      );
      return toSourceVideo(video, subscribersByChannel);
    },
    async getCollection(
      collection: YouTubeSourceCollectionLookup,
    ): Promise<YouTubeSourceCollection | null> {
      let title: string;
      let id = collection.id;
      let playlistId: string;
      let kind = collection.kind;
      if (collection.kind === "channel") {
        const params = new URLSearchParams({
          part: "snippet,contentDetails,statistics",
          [collection.lookup === "id" ? "id" : "forHandle"]: collection.id,
        });
        const channels = await request("channels", params);
        const channel = record(channels[0]);
        const channelId = stringValue(channel?.id);
        title = stringValue(nested(channel, "snippet")?.title) ?? "YouTube channel";
        const subscriberCount = safeCount(
          stringValue(nested(channel, "statistics")?.subscriberCount),
        );
        playlistId =
          stringValue(nested(nested(channel, "contentDetails"), "relatedPlaylists")?.uploads) ?? "";
        if (!channelId || !playlistId) return null;
        id = channelId;
        const entries = await videosInPlaylist(playlistId, collection.limit);
        const videos = await enrichCollectionVideos(entries);
        return {
          kind,
          id,
          title,
          url: `https://www.youtube.com/channel/${id}`,
          videos: videos.map((video) => ({ ...video, subscriberCount })),
        };
      }

      const playlists = await request(
        "playlists",
        new URLSearchParams({ part: "snippet", id: collection.id }),
      );
      const playlist = record(playlists[0]);
      const playlistIdValue = stringValue(playlist?.id);
      if (!playlistIdValue) return null;
      id = playlistIdValue;
      kind = "playlist";
      title = stringValue(nested(playlist, "snippet")?.title) ?? "YouTube playlist";
      playlistId = id;
      const entries = await videosInPlaylist(playlistId, collection.limit);
      return {
        kind,
        id,
        title,
        url: `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`,
        videos: await enrichCollectionVideos(entries),
      };
    },
  };
};
