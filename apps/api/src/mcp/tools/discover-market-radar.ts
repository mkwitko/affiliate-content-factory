import type { UserId } from "@money-maker/contracts";
import type { TrendKeyword } from "@money-maker/core/offers/marketplace-catalog";
import {
  buildMarketRadar,
  normalizeMarketKeyword,
  type MarketRadarVideoSearch,
} from "@money-maker/core/research/market-radar";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const discoverMarketRadarInputSchema = z
  .object({
    workspaceId: z.uuid(),
    categoryId: z
      .string()
      .regex(/^MLB\d+$/)
      .optional(),
    limit: z.number().int().min(1).max(3).default(3),
  })
  .strict();

export const discoverMarketRadarTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = discoverMarketRadarInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;

  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!catalog?.readTrends) return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  let trends: readonly TrendKeyword[];
  try {
    trends = await catalog.readTrends(parsed.data.categoryId);
  } catch (error) {
    if (error instanceof Error && error.message === "category_not_found")
      return { ok: false, error: "NOT_FOUND" };
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }

  const observedAt = new Date();
  const uniqueTrends = [
    ...new Map(trends.map((trend) => [normalizeMarketKeyword(trend.keyword), trend])).values(),
  ];
  const topTrends = uniqueTrends.slice(0, parsed.data.limit);
  const youtube = deps.youtubeSourceDiscovery;
  const searches: MarketRadarVideoSearch[] = [];
  let youtubeFailures = 0;
  const failedQueries = new Set<string>();
  if (youtube) {
    const results = await Promise.allSettled(
      topTrends.map(async ({ keyword }) => ({
        query: keyword,
        videos: await youtube.searchVideos({
          query: keyword,
          regionCode: "BR",
          relevanceLanguage: "pt",
          publishedAfter: new Date(observedAt.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          order: "viewCount",
          limit: 10,
        }),
      })),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") searches.push(result.value);
      else {
        youtubeFailures += 1;
        const trend = topTrends[index];
        if (trend) failedQueries.add(normalizeMarketKeyword(trend.keyword));
      }
    }
  }

  const candidates = buildMarketRadar({
    trends: topTrends,
    youtube: searches,
    observedAt,
    totalTrendCount: trends.length,
  });
  const missingSourceReason = !youtube
    ? "not_configured"
    : youtubeFailures > 0
      ? searches.length > 0
        ? "partial_provider_failure"
        : "provider_unavailable"
      : "no_matching_recent_video";
  return {
    ok: true,
    value: {
      observedAt: observedAt.toISOString(),
      categoryId: parsed.data.categoryId ?? null,
      persisted: false,
      sources: {
        mercadoLivre: trends.length > 0 ? "available" : "empty",
        youtube: !youtube
          ? "not_configured"
          : youtubeFailures === 0
            ? "available"
            : searches.length > 0
              ? "partial_failure"
              : "unavailable",
        youtubeSearchCalls: searches.length + youtubeFailures,
        youtubeSearchCallLimit: parsed.data.limit,
      },
      interpretation:
        "Mercado Livre weekly ranks and recent YouTube video activity are separate signals. Video views indicate content activity, not buyer demand or sales. Numeric growth is unavailable without comparable source history.",
      candidates: candidates.map((candidate) => ({
        ...candidate,
        missingSourceReasons: candidate.missingSources.map((source) => ({
          source,
          reason: failedQueries.has(normalizeMarketKeyword(candidate.keyword))
            ? "provider_unavailable"
            : missingSourceReason === "partial_provider_failure"
              ? "no_matching_recent_video"
              : missingSourceReason,
        })),
      })),
    },
  };
};
