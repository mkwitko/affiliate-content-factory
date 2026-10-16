import type { TrendKeyword } from "../offers/marketplace-catalog.js";

export type MarketRadarVideoSearch = Readonly<{
  query: string;
  videos: readonly Readonly<{
    videoId: string;
    title: string;
    url: string;
    publishedAt: string;
    viewCount: number | null;
  }>[];
}>;

export type MarketRadarCandidate = Readonly<{
  keyword: string;
  rank: number;
  rankGroup: "fastest_growth" | "most_wanted" | "popular" | null;
  confidence: "low" | "corroborated";
  sourceCount: number;
  demandValidated: false;
  growth7d: null;
  growth30d: null;
  growth90d: null;
  observedAt: Date;
  evidence: readonly Readonly<{
    source: "mercado_livre_trends" | "youtube_recent_video";
    sourceUrl: string | null;
    value: string;
    unit: "weekly_rank" | "video_views";
  }>[];
  missingSources: readonly "youtube_recent_video"[];
}>;

export const normalizeMarketKeyword = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const hasKeywordInTitle = (keyword: string, title: string) => {
  const terms = normalizeMarketKeyword(keyword)
    .split(" ")
    .filter((term) => term.length > 2);
  const titleTerms = new Set(normalizeMarketKeyword(title).split(" "));
  return terms.length > 0 && terms.every((term) => titleTerms.has(term));
};

const safeMercadoLivreUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "mercadolivre.com.br" || url.hostname.endsWith(".mercadolivre.com.br"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const safeYouTubeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["youtube.com", "www.youtube.com", "youtu.be"].includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const rankGroup = (rank: number, total: number): MarketRadarCandidate["rankGroup"] => {
  if (total !== 50) return null;
  if (rank <= 10) return "fastest_growth";
  if (rank <= 30) return "most_wanted";
  return "popular";
};

export const buildMarketRadar = (
  input: Readonly<{
    trends: readonly TrendKeyword[];
    youtube: readonly MarketRadarVideoSearch[];
    observedAt: Date;
    totalTrendCount?: number;
  }>,
): readonly MarketRadarCandidate[] => {
  const searches = new Map(
    input.youtube.map((entry) => [normalizeMarketKeyword(entry.query), entry.videos]),
  );
  const seen = new Set<string>();
  const candidates: MarketRadarCandidate[] = [];

  input.trends.slice(0, 50).forEach((trend, index) => {
    const normalizedKeyword = normalizeMarketKeyword(trend.keyword);
    if (!normalizedKeyword || seen.has(normalizedKeyword)) return;
    seen.add(normalizedKeyword);
    const rank = index + 1;
    const recentVideos = (searches.get(normalizedKeyword) ?? []).filter((video) => {
      const publishedAt = Date.parse(video.publishedAt);
      return (
        Number.isFinite(publishedAt) &&
        publishedAt <= input.observedAt.getTime() &&
        publishedAt >= input.observedAt.getTime() - 30 * 24 * 60 * 60 * 1000 &&
        hasKeywordInTitle(trend.keyword, video.title) &&
        safeYouTubeUrl(video.url) !== null
      );
    });
    const evidence: MarketRadarCandidate["evidence"][number][] = [
      {
        source: "mercado_livre_trends",
        sourceUrl: safeMercadoLivreUrl(trend.url),
        value: `rank:${rank}`,
        unit: "weekly_rank",
      },
      ...recentVideos.map((video) => ({
        source: "youtube_recent_video" as const,
        sourceUrl: safeYouTubeUrl(video.url),
        value: `views:${video.viewCount ?? "unknown"}`,
        unit: "video_views" as const,
      })),
    ];
    const sourceCount = 1 + (recentVideos.length > 0 ? 1 : 0);
    candidates.push({
      keyword: trend.keyword,
      rank,
      rankGroup: rankGroup(rank, input.totalTrendCount ?? input.trends.length),
      confidence: sourceCount === 2 ? "corroborated" : "low",
      sourceCount,
      demandValidated: false,
      growth7d: null,
      growth30d: null,
      growth90d: null,
      observedAt: new Date(input.observedAt),
      evidence,
      missingSources: recentVideos.length === 0 ? ["youtube_recent_video"] : [],
    });
  });

  return candidates;
};
