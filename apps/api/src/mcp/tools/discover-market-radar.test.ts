import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { TrendKeyword } from "@money-maker/core/offers/marketplace-catalog";
import type { YouTubeSourceVideo } from "@money-maker/core/research/youtube-discovery";
import type { McpDependencies } from "../server.js";
import { discoverMarketRadarTool } from "./discover-market-radar.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const video = (title: string): YouTubeSourceVideo => ({
  videoId: "abcdefghijk",
  title,
  channelId: "UCabcdefghijklmnopqrstuv",
  channelTitle: "Channel",
  publishedAt: new Date(Date.now() - 60_000).toISOString(),
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  durationSeconds: 120,
  viewCount: 1200,
  license: "youtube",
  captionsAvailable: true,
  defaultLanguage: "pt",
  channelUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  subscriberCount: 20,
});

const dependencies = (
  input: Readonly<{
    trends?: readonly TrendKeyword[];
    searchVideos?: (query: string) => Promise<readonly YouTubeSourceVideo[]>;
    member?: boolean;
  }>,
): McpDependencies =>
  ({
    workspaces: {
      findMembership: async () =>
        input.member === false ? null : { workspaceId, userId, role: "owner", status: "active" },
    },
    marketplaceCatalogForWorkspace: () => ({
      search: async () => [],
      readProductEvidence: async () => {
        throw new Error("not_used");
      },
      readBuyerVoice: async () => {
        throw new Error("not_used");
      },
      readTrends: async () => input.trends ?? [],
    }),
    ...(input.searchVideos
      ? {
          youtubeSourceDiscovery: {
            searchVideos: vi.fn(
              async ({ query }: { query: string }) => input.searchVideos?.(query) ?? [],
            ),
          },
        }
      : {}),
  }) as unknown as McpDependencies;

describe("discover_market_radar MCP tool", () => {
  it("uses the bounded two-source pilot and returns evidence-linked candidates", async () => {
    const searchVideos = vi.fn(async (query: string) => [video(`Review ${query}`)]);
    const deps = dependencies({
      trends: [
        { keyword: "sérum facial", url: "https://lista.mercadolivre.com.br/serum" },
        { keyword: "creme hidratante", url: "https://lista.mercadolivre.com.br/creme" },
        { keyword: "protetor solar", url: "https://lista.mercadolivre.com.br/protetor" },
        { keyword: "base facial", url: "https://lista.mercadolivre.com.br/base" },
        ...Array.from({ length: 46 }, (_, index) => ({
          keyword: `produto teste ${index}`,
          url: `https://lista.mercadolivre.com.br/teste-${index}`,
        })),
      ],
      searchVideos,
    });

    const result = await discoverMarketRadarTool(
      { workspaceId, categoryId: "MLB1246", limit: 3 },
      userId,
      deps,
    );

    expect(searchVideos).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: true,
      value: {
        categoryId: "MLB1246",
        persisted: false,
        sources: { youtube: "available", youtubeSearchCalls: 3, youtubeSearchCallLimit: 3 },
        candidates: [
          {
            keyword: "sérum facial",
            rankGroup: "fastest_growth",
            sourceCount: 2,
            demandValidated: false,
          },
          { keyword: "creme hidratante", sourceCount: 2, demandValidated: false },
          { keyword: "protetor solar", sourceCount: 2, demandValidated: false },
        ],
      },
    });
  });

  it("returns marketplace-only candidates when YouTube is unavailable and bounds quota", async () => {
    const result = await discoverMarketRadarTool(
      { workspaceId, limit: 2 },
      userId,
      dependencies({
        trends: [
          { keyword: "serum facial", url: "https://lista.mercadolivre.com.br/serum" },
          { keyword: "creme facial", url: "https://lista.mercadolivre.com.br/creme" },
        ],
        searchVideos: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        sources: { youtube: "unavailable", youtubeSearchCalls: 2 },
        candidates: [
          {
            confidence: "low",
            sourceCount: 1,
            demandValidated: false,
            missingSourceReasons: [
              { source: "youtube_recent_video", reason: "provider_unavailable" },
            ],
          },
          { confidence: "low", sourceCount: 1, demandValidated: false },
        ],
      },
    });
  });

  it("rejects invalid input and denies workspace outsiders before provider calls", async () => {
    const deps = dependencies({ trends: [], member: false });
    expect(
      await discoverMarketRadarTool({ workspaceId, categoryId: "../bad", limit: 4 }, userId, deps),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(await discoverMarketRadarTool({ workspaceId }, userId, deps)).toMatchObject({
      ok: false,
    });
  });
});
