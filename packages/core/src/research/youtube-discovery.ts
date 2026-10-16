export type YouTubeSourceVideo = Readonly<{
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  durationSeconds: number | null;
  viewCount: number | null;
  license: "creativeCommon" | "youtube" | "unknown";
  captionsAvailable: boolean | null;
  defaultLanguage: string | null;
  channelUrl: string;
  subscriberCount: number | null;
}>;

export type YouTubeVideoSearchInput = Readonly<{
  query: string;
  regionCode?: string;
  relevanceLanguage?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  order?: "relevance" | "date" | "viewCount";
  license?: "any" | "creativeCommon";
  limit: number;
}>;

export type YouTubeSourceCollectionLookup = Readonly<{
  kind: "channel" | "playlist";
  id: string;
  lookup: "id" | "handle";
  limit: number;
}>;

export type YouTubeSourceCollection = Readonly<{
  kind: "channel" | "playlist";
  id: string;
  title: string;
  url: string;
  videos: readonly YouTubeSourceVideo[];
}>;

const youTubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youTubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export const parseYouTubeVideoId = (sourceUrl: string): string | null => {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !youTubeHosts.has(url.hostname.toLowerCase())
  )
    return null;

  let videoId: string | null = null;
  if (url.hostname.toLowerCase() === "youtu.be" || url.hostname.toLowerCase() === "www.youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) videoId = parts[0] ?? null;
  } else if (url.pathname === "/watch") {
    const values = url.searchParams.getAll("v");
    if (values.length === 1) videoId = values[0] ?? null;
  } else {
    const match = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    videoId = match?.[1] ?? null;
  }
  return videoId && youTubeVideoIdPattern.test(videoId) ? videoId : null;
};

export interface YouTubeSourceDiscovery {
  searchVideos(input: YouTubeVideoSearchInput): Promise<readonly YouTubeSourceVideo[]>;
  getVideo(videoId: string): Promise<YouTubeSourceVideo | null>;
  getCollection(input: YouTubeSourceCollectionLookup): Promise<YouTubeSourceCollection | null>;
}

export const parseYouTubeDurationSeconds = (duration: string): number | null => {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
};

const sourceHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const playlistIdPattern = /^[A-Za-z0-9_-]{10,128}$/;
const handlePattern = /^[A-Za-z0-9._-]{3,30}$/;

export const parseYouTubeSourceCollection = (
  sourceUrl: string,
): Omit<YouTubeSourceCollectionLookup, "limit"> | null => {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !sourceHosts.has(url.hostname.toLowerCase())
  )
    return null;

  const channel = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/videos)?\/?$/.exec(url.pathname);
  if (channel?.[1] && channelIdPattern.test(channel[1]))
    return { kind: "channel", id: channel[1], lookup: "id" };

  const handle = /^\/@([A-Za-z0-9._-]{3,30})(?:\/videos)?\/?$/.exec(url.pathname);
  if (handle?.[1] && handlePattern.test(handle[1]))
    return { kind: "channel", id: handle[1], lookup: "handle" };

  if (url.pathname === "/playlist") {
    const ids = url.searchParams.getAll("list");
    if (ids.length === 1 && ids[0] && playlistIdPattern.test(ids[0]))
      return { kind: "playlist", id: ids[0], lookup: "id" };
  }
  return null;
};
