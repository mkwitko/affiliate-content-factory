import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type { ResearchSnapshot } from "@money-maker/core/research/research-snapshot";
import type { ProductPostingHistoryRepository } from "@money-maker/core/offers/product-posting-history";
import type { McpDependencies } from "../server.js";
import { getGenerationContextTool } from "./get-generation-context.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({
    workspaceId,
    userId: actorId,
    role: "reviewer",
    status: "active",
  }),
  addMembership: async () => undefined,
  getContext: async () => ({ mission: "Example Shop", cta: "Compre agora" }),
};

const nicheRepository: NicheRepository = {
  create: async (value) => value,
  listForWorkspace: async () => [],
  findForWorkspace: async ({ nicheId }) =>
    nicheId === "niche-1"
      ? {
          id: "niche-1",
          workspaceId,
          name: "Cafeteiras portáteis",
          audience: "Viajantes",
          problem: "Café ruim em viagem",
          editorialVoice: "Direto",
          languages: ["pt-BR"],
          monetizationHypothesis: "Afiliados",
          state: "active",
          kind: "affiliate",
          context: { promise: "Café bom em qualquer lugar" },
        }
      : null,
  updateState: async () => null,
};

const channelRepository: ChannelRepository = {
  create: async (value) => value,
  findForWorkspace: async ({ channelId }) =>
    channelId === "channel-1"
      ? {
          id: "channel-1",
          workspaceId,
          connectionId: "connection-1",
          kind: "instagram_carousel",
          label: "Instagram principal",
          status: "active",
          capabilities: {
            maxAssets: 10,
            requiresOrderedAssets: true,
            allowedMimeTypes: ["image/jpeg"],
            captionMaxLength: 2200,
          },
          context: { cta: "Salve este post" },
        }
      : null,
  updateStatus: async () => null,
};

const activeSnapshot: ResearchSnapshot = {
  id: "snapshot-1",
  workspaceId,
  provider: "manual",
  nicheId: "niche-1",
  query: "cafeteira portátil",
  locale: "pt-BR",
  observedAt: new Date("2026-09-21T00:00:00.000Z"),
  expiresAt: new Date("2026-09-28T00:00:00.000Z"),
  observations: [
    { id: "obs-1", key: "keyword", value: "cafeteira portátil", sourceUrl: "https://example.test" },
  ],
  contentHash: "hash-1",
  actorId,
};

const researchRepository: ResearchRepository = {
  create: async (value) => value,
  findByHash: async () => null,
  findActiveForNiche: async () => [activeSnapshot],
};

describe("get_generation_context MCP tool", () => {
  it("resolves brand, niche, and channel context with a later-layer-wins merge, plus active research", async () => {
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      channelRepository,
      researchRepository,
    };

    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
      actorId,
      dependencies,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        recommendation: expect.objectContaining({
          format: "carousel",
          pipeline: "build_post_creatives",
        }),
        brand: { mission: "Example Shop", cta: "Compre agora" },
        niche: { promise: "Café bom em qualquer lugar" },
        channel: { cta: "Salve este post" },
        research: {
          keywords: ["cafeteira portátil"],
          pains: [],
          referenceProducts: [],
          exclusions: [],
        },
        merged: {
          mission: "Example Shop",
          cta: "Salve este post",
          promise: "Café bom em qualquer lugar",
        },
        recentProducts: [],
        characters: [],
      },
    });
  });

  it("lists the niche characters with stable public URLs for their reference sheets", async () => {
    const nicheWithCharacters: NicheRepository = {
      ...nicheRepository,
      findForWorkspace: async (query) => {
        const niche = await nicheRepository.findForWorkspace(query);
        return niche
          ? {
              ...niche,
              context: {
                storyWorld: "Apartamento em Campinas.",
                characters: [
                  {
                    name: "Carla",
                    role: "main",
                    description: "Protagonista.",
                    referenceAssetIds: ["asset-1"],
                  },
                  { name: "Paçoca", role: "pet", description: "Vira-lata caramelo." },
                ],
              },
            }
          : null;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository: nicheWithCharacters,
      channelRepository,
      researchRepository,
      publicApiUrl: "https://example.test/",
    };

    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
      actorId,
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect((result.value as { characters: unknown }).characters).toEqual([
      {
        name: "Carla",
        role: "main",
        description: "Protagonista.",
        referenceAssetIds: ["asset-1"],
        referenceUrls: [
          `https://example.test/v1/public/workspaces/${workspaceId}/assets/asset-1`,
        ],
      },
      { name: "Paçoca", role: "pet", description: "Vira-lata caramelo.", referenceUrls: [] },
    ]);
  });

  it("lists the niche's recently posted products, newest first, capped at 20", async () => {
    const history = Array.from({ length: 25 }, (_unused, index) => ({
      productId: `MLB${index}`,
      offerTitle: `Product ${index}`,
      lastPublishedAt: new Date(2026, 8, 24 - index),
      publishedCount: 1,
      channels: ["instagram_carousel"] as const,
    }));
    const productPostingHistoryRepository: ProductPostingHistoryRepository = {
      productPostingHistory: async () => history,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      channelRepository,
      researchRepository,
      productPostingHistoryRepository,
    };

    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
      actorId,
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    const recentProducts = (result.value as { recentProducts: unknown[] }).recentProducts;
    expect(recentProducts).toHaveLength(20);
    expect(recentProducts[0]).toEqual({
      title: "Product 0",
      productId: "MLB0",
      lastPostedAt: history[0]?.lastPublishedAt.toISOString(),
      channels: ["instagram_carousel"],
    });
  });

  it("never exposes Channel.context.tiktokShop in the channel or merged creative context", async () => {
    const tiktokShop = {
      version: 1,
      state: "shop_enabled",
      observedAt: "2026-09-28T12:00:00.000Z",
      source: "operator_confirmation",
    };
    const channelWithShopStatus: ChannelRepository = {
      ...channelRepository,
      findForWorkspace: async ({ channelId }) =>
        channelId === "channel-1"
          ? {
              id: "channel-1",
              workspaceId,
              connectionId: "connection-1",
              kind: "tiktok_video",
              label: "TikTok",
              status: "active",
              capabilities: {
                maxAssets: 1,
                requiresOrderedAssets: false,
                allowedMimeTypes: ["video/mp4"],
                captionMaxLength: 2200,
              },
              context: { cta: "Salve este post", tiktokShop },
            }
          : null,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      channelRepository: channelWithShopStatus,
      researchRepository,
    };

    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
      actorId,
      dependencies,
    );
    if (!result.ok) throw new Error("expected ok result");
    const value = result.value as { channel: unknown; merged: Record<string, unknown> };
    expect(value.channel).toEqual({ cta: "Salve este post" });
    expect(value.merged.tiktokShop).toBeUndefined();
  });

  it("returns NOT_FOUND when the channel does not belong to the workspace", async () => {
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      channelRepository,
      researchRepository,
    };

    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "missing" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("recommends the winning hook move from learnings and honours the policy allow-list", async () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => ({ arm: "contrast", shares: 10 + (i % 2) })),
      ...Array.from({ length: 9 }, (_, i) => ({ arm: "proof_first", shares: 30 + (i % 2) })),
    ].map((row, index) => ({
      contentVariantId: `v${index}`,
      channelId: "channel-1",
      channelKind: "instagram_carousel" as const,
      publishedAt: new Date("2026-09-20T15:00:00Z"),
      observedAt: new Date("2026-09-27T15:00:00Z"),
      metrics: { shares: row.shares },
      creativeFeatures: { hookMove: row.arm },
      uniqueClicks: 0,
    }));
    const dependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      channelRepository,
      researchRepository,
      performanceRepository: { observationsAtCheckpoint: async () => rows },
      publicationPolicyRepository: {
        findForWorkspace: async () => ({
          workspaceId,
          mode: "manual",
          version: 1,
          allowedFormats: ["carousel"],
        }),
      },
    } as unknown as McpDependencies;
    const result = await getGenerationContextTool(
      { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { recommendation: { format: "carousel", hookMove: "proof_first" } },
    });
  });

  it("changes the fallback seed as the niche gains content items", async () => {
    const seen = new Set<string>();
    for (let count = 0; count < 12; count += 1) {
      const items = Array.from({ length: count }, (_, i) => ({
        id: `item-${count - i}`,
        nicheId: "niche-1",
      }));
      const dependencies = {
        authenticate: async () => ({ userId: actorId }),
        invitation: {} as McpDependencies["invitation"],
        workspaces,
        nicheRepository,
        channelRepository,
        researchRepository,
        contentRepository: {
          listVariantsForWorkspace: async () => [],
          listContentItemsForWorkspace: async () => items,
        },
      } as unknown as McpDependencies;
      const result = await getGenerationContextTool(
        { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
        actorId,
        dependencies,
      );
      const recommendation = (
        result as unknown as { value: { recommendation: Record<string, string> } }
      ).value.recommendation;
      seen.add(`${recommendation["format"]}:${recommendation["hookMove"]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("recommends the trial ai_story format only for a niche that opted in", async () => {
    const run = async (experiments: Record<string, unknown> | undefined) => {
      const dependencies = {
        authenticate: async () => ({ userId: actorId }),
        invitation: {} as McpDependencies["invitation"],
        workspaces,
        nicheRepository: {
          ...nicheRepository,
          findForWorkspace: async (input: { nicheId: string; workspaceId: typeof workspaceId }) => {
            const niche = await nicheRepository.findForWorkspace(input);
            return niche
              ? { ...niche, context: { ...niche.context, ...(experiments ? { experiments } : {}) } }
              : null;
          },
        },
        channelRepository: {
          ...channelRepository,
          findForWorkspace: async (input: {
            channelId: string;
            workspaceId: typeof workspaceId;
          }) => {
            const channel = await channelRepository.findForWorkspace(input);
            return channel ? { ...channel, kind: "instagram_reels" as const } : null;
          },
        },
        researchRepository,
        publicationPolicyRepository: {
          findForWorkspace: async () => ({
            workspaceId,
            mode: "manual",
            version: 1,
            allowedFormats: ["ai_story"],
          }),
        },
      } as unknown as McpDependencies;
      return getGenerationContextTool(
        { workspaceId, nicheId: "niche-1", channelId: "channel-1" },
        actorId,
        dependencies,
      );
    };
    expect(await run(undefined)).toMatchObject({
      ok: true,
      value: { recommendation: { format: null } },
    });
    expect(await run({ allowTrialRenderers: false })).toMatchObject({
      ok: true,
      value: { recommendation: { format: null } },
    });
    expect(await run({ allowTrialRenderers: true })).toMatchObject({
      ok: true,
      value: { recommendation: { format: "ai_story" } },
    });
  });
});
