import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type { ResearchSnapshot } from "@money-maker/core/research/research-snapshot";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";
import { createDefaultPublicationPolicy } from "@money-maker/core/workspaces/publication-policy";
import type { McpDependencies } from "../server.js";
import { getSetupStatusTool } from "./get-setup-status.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces = (context: Record<string, unknown> | null = null): WorkspaceRepository => ({
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
  getContext: async () => context,
});

const baseNiche: Niche = {
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
};

const baseSnapshot: ResearchSnapshot = {
  id: "snapshot-1",
  workspaceId,
  provider: "manual",
  nicheId: "niche-1",
  query: "cafeteira portátil",
  locale: "pt-BR",
  observedAt: new Date("2026-09-20T00:00:00Z"),
  expiresAt: new Date("2026-10-20T00:00:00Z"),
  observations: [
    { id: "obs-1", key: "keyword", value: "cafeteira", sourceUrl: "https://example.com" },
  ],
  contentHash: "hash",
  actorId,
};

const baseChannel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "conn-post-for-me",
  kind: "instagram_carousel",
  label: "Instagram",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: false,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2000,
  },
};

const activeConnection = (provider: ProviderConnection["provider"]): ProviderConnection => ({
  id: `conn-${provider}`,
  workspaceId,
  provider,
  mode: provider === "post_for_me" ? "api_key" : "oauth",
  secretReference: `secret://workspace/${workspaceId}/${provider}`,
  accountId: `account-${provider}`,
  status: "active",
});

const baseOffer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://produto.mercadolivre.com.br/1",
  title: "Cafeteira portátil",
  state: "active",
  snapshots: [],
};

const publishedVariant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: "channel-1",
  offerSnapshotId: "snapshot-1",
  assetIds: [],
  caption: "Caption",
  language: "pt-BR",
  state: "published",
  voiceScript: [],
};

const emptyDependencies = (): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: workspaces(null),
});

const emptyNicheRepository: NicheRepository = {
  create: async (value) => value,
  listForWorkspace: async () => [],
  findForWorkspace: async () => null,
  updateState: async () => null,
};
const emptyChannelRepository: ChannelRepository = {
  create: async (value) => value,
  listForWorkspace: async () => [],
  findForWorkspace: async () => null,
  updateStatus: async () => null,
};
const emptyResearchRepository: ResearchRepository = {
  create: async (snapshot) => snapshot,
  findByHash: async () => null,
  listForWorkspace: async () => [],
};
const emptyProviderConnections: ProviderConnectionRepository = {
  create: async (connection) => ({ ok: true, connection }),
  findAllForWorkspace: async () => [],
  findForWorkspace: async () => null,
  revoke: async () => undefined,
};
const emptyOfferRepository: OfferRepository = {
  create: async (offer) => offer,
  listForWorkspace: async () => [],
  findForWorkspace: async () => null,
  addSnapshot: async () => null,
  activate: async () => null,
  reject: async () => null,
};
const emptyContentRepository: ContentRepository = {
  listContentItemsWithoutActiveVariants: async () => [],
  updateContentItemState: async () => null,
  createContentItem: async (item) => item,
  findContentItemForWorkspace: async () => null,
  createVariant: async (variant) => variant,
  listVariantsForWorkspace: async () => [],
  findVariantForWorkspace: async () => null,
  findReviewableForWorkspace: async () => [],
  updateVariant: async (variant) => variant,
  updateContentItem: async (item) => item,
  recordApproval: async (input) => input.variant,
};
const defaultPublicationPolicyRepository: PublicationPolicyRepository = {
  findForWorkspace: async () => createDefaultPublicationPolicy(workspaceId),
  create: async (policy) => policy,
  update: async (policy) => policy,
};

const fullyWiredEmptyDependencies = (): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: workspaces(null),
  nicheRepository: emptyNicheRepository,
  channelRepository: emptyChannelRepository,
  researchRepository: emptyResearchRepository,
  providerConnections: emptyProviderConnections,
  offerRepository: emptyOfferRepository,
  contentRepository: emptyContentRepository,
  publicationPolicyRepository: defaultPublicationPolicyRepository,
});

describe("get_setup_status", () => {
  it("returns every computable stage as pending/next, and unavailable when no repos are wired at all", async () => {
    const result = await getSetupStatusTool({ workspaceId }, actorId, emptyDependencies());
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{ id: string; status: string }>;
    expect(stages.find((s) => s.id === "plugins")).toMatchObject({ status: "unavailable" });
    expect(stages.every((s) => s.id === "plugins" || s.status === "unavailable")).toBe(true);
  });

  it("sequences stages with exactly one next once the repos are wired but empty", async () => {
    const result = await getSetupStatusTool(
      { workspaceId },
      actorId,
      fullyWiredEmptyDependencies(),
    );
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{ id: string; status: string }>;
    expect(stages.find((s) => s.id === "niche_research")).toMatchObject({ status: "next" });
    expect(stages.find((s) => s.id === "structure")).toMatchObject({ status: "pending" });
    expect(stages.filter((s) => s.status === "next")).toHaveLength(1);
  });

  it("marks niche_research unavailable instead of throwing when the research repo has no listForWorkspace", async () => {
    const researchRepository: ResearchRepository = {
      create: async (snapshot) => snapshot,
      findByHash: async () => null,
      // listForWorkspace intentionally omitted
    };
    const dependencies: McpDependencies = { ...emptyDependencies(), researchRepository };
    const result = await getSetupStatusTool({ workspaceId }, actorId, dependencies);
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{ id: string; status: string }>;
    expect(stages.find((s) => s.id === "niche_research")).toMatchObject({ status: "unavailable" });
  });

  it("reports Canva as recommended and keeps integrations done without it", async () => {
    const dependencies: McpDependencies = {
      ...fullyWiredEmptyDependencies(),
      providerConnections: {
        ...emptyProviderConnections,
        findAllForWorkspace: async () => [
          activeConnection("post_for_me"),
          activeConnection("mercado_livre"),
        ],
      },
    };
    const result = await getSetupStatusTool({ workspaceId }, actorId, dependencies);
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{
      id: string;
      status: string;
      connections?: Array<{ provider: string; required: boolean; connected: boolean }>;
    }>;
    const integrations = stages.find((stage) => stage.id === "integrations");
    expect(integrations?.connections).toEqual([
      { provider: "post_for_me", required: true, connected: true },
      { provider: "mercado_livre", required: true, connected: true },
      { provider: "canva", required: false, connected: false },
    ]);
    // "integrations done without Canva" is pinned by the fully configured workspace test below,
    // whose connections are Post For Me and Mercado Livre only.
  });

  it("marks canva connected only when its connection is active", async () => {
    const dependencies: McpDependencies = {
      ...fullyWiredEmptyDependencies(),
      providerConnections: {
        ...emptyProviderConnections,
        findAllForWorkspace: async () => [
          activeConnection("post_for_me"),
          activeConnection("mercado_livre"),
          { ...activeConnection("canva"), status: "revoked" },
        ],
      },
    };
    const result = await getSetupStatusTool({ workspaceId }, actorId, dependencies);
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{
      id: string;
      connections?: Array<{ provider: string; required: boolean; connected: boolean }>;
    }>;
    const canva = stages
      .find((stage) => stage.id === "integrations")
      ?.connections?.find((connection) => connection.provider === "canva");
    expect(canva).toEqual({ provider: "canva", required: false, connected: false });
  });

  it("never makes automations the next stage", async () => {
    const result = await getSetupStatusTool({ workspaceId }, actorId, {
      ...fullyWiredEmptyDependencies(),
      researchPolicyRepository: {
        listForWorkspace: async () => [],
      } as unknown as NonNullable<McpDependencies["researchPolicyRepository"]>,
    });
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{ id: string; status: string; optional?: true }>;
    const automations = stages.find((stage) => stage.id === "automations");
    expect(automations).toMatchObject({ optional: true });
    expect(automations?.status).not.toBe("next");
  });

  it("marks every computable stage done for a fully configured workspace", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [{ ...baseNiche, context: { promise: "x" } }],
      findForWorkspace: async () => baseNiche,
      updateState: async () => null,
    };
    const channelRepository: ChannelRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [{ ...baseChannel, context: { role: "x" } }],
      findForWorkspace: async () => baseChannel,
      updateStatus: async () => null,
    };
    const researchRepository: ResearchRepository = {
      create: async (snapshot) => snapshot,
      findByHash: async () => null,
      listForWorkspace: async () => [baseSnapshot],
    };
    const providerConnections: ProviderConnectionRepository = {
      create: async (connection) => ({ ok: true, connection }),
      findAllForWorkspace: async () => [
        activeConnection("post_for_me"),
        activeConnection("mercado_livre"),
      ],
      findForWorkspace: async () => null,
      revoke: async () => undefined,
    };
    const offerRepository: OfferRepository = {
      create: async (offer) => offer,
      listForWorkspace: async () => [baseOffer],
      findForWorkspace: async () => baseOffer,
      addSnapshot: async () => baseOffer,
      activate: async () => baseOffer,
      reject: async () => baseOffer,
    };
    const contentRepository: ContentRepository = {
      listContentItemsWithoutActiveVariants: async () => [],
      updateContentItemState: async () => null,
      createContentItem: async (item) => item,
      updateContentItem: async (item) => item,
      findContentItemForWorkspace: async () => null,
      createVariant: async (variant) => variant,
      listVariantsForWorkspace: async () => [publishedVariant],
      findVariantForWorkspace: async () => publishedVariant,
      findReviewableForWorkspace: async () => [],
      updateVariant: async (variant) => variant,
      recordApproval: async (input) => input.variant,
    };
    const publicationPolicyRepository: PublicationPolicyRepository = {
      findForWorkspace: async () => ({
        ...createDefaultPublicationPolicy(workspaceId),
        mode: "policy_based",
      }),
      create: async (policy) => policy,
      update: async (policy) => policy,
    };

    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces: workspaces({ mission: "x" }),
      nicheRepository,
      channelRepository,
      researchRepository,
      providerConnections,
      offerRepository,
      contentRepository,
      publicationPolicyRepository,
    };

    const result = await getSetupStatusTool({ workspaceId }, actorId, dependencies);
    if (!result.ok) throw new Error("expected ok result");
    const stages = result.value.stages as Array<{ id: string; status: string }>;
    for (const stage of stages) {
      if (stage.id === "plugins") continue;
      if (stage.id === "automations") continue; // research policy repo not wired until Task 3
      expect(stage.status).toBe("done");
    }
  });
});
