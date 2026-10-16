import type { WorkspaceId } from "@money-maker/contracts";
import type { BurnInDeps } from "@money-maker/core/autonomy/burn-in";
import type { MarketplaceCatalog } from "@money-maker/core/offers/marketplace-catalog";
import { PrismaAssetRepository } from "@money-maker/providers/database/asset-repository";
import type { DatabaseClient } from "@money-maker/providers/database/client";
import { PrismaContentRepository } from "@money-maker/providers/database/content-repository";
import { PrismaHomeWorkerTokenRepository } from "@money-maker/providers/database/home-worker-token-repository";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";
import { PrismaOfferRepository } from "@money-maker/providers/database/offer-repository";
import { PrismaProductCandidateRepository } from "@money-maker/providers/database/product-candidate-repository";
import { PrismaProductPostingHistoryRepository } from "@money-maker/providers/database/product-posting-history-repository";
import { PrismaPublicationAttemptRepository } from "@money-maker/providers/database/publication-repository";
import { PrismaResearchPolicyRepository } from "@money-maker/providers/database/research-policy-repository";
import { PostgresJobQueue } from "@money-maker/providers/jobs/postgres-job-queue";

const AFFILIATE_LINK_BUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder";

/**
 * The one place that wires autonomy dependencies to Postgres: the worker loop uses `cycle`,
 * the burn-in command uses all three parts.
 */
export const buildAutonomyDeps = (
  client: DatabaseClient,
  marketplaceCatalogForWorkspace: (workspaceId: WorkspaceId) => MarketplaceCatalog,
  settings: Readonly<{ generationPolicy: string; autonomyEnabled: boolean }> = {
    generationPolicy: "cloud_allowed",
    autonomyEnabled: false,
  },
): BurnInDeps => {
  const niches = new PrismaNicheRepository(client);
  const policies = new PrismaResearchPolicyRepository(client);
  const candidates = new PrismaProductCandidateRepository(client);
  const content = new PrismaContentRepository(client);
  const jobs = new PostgresJobQueue(client);
  return {
    cycle: {
      niches,
      policies,
      candidates,
      offers: new PrismaOfferRepository(client),
      postingHistory: new PrismaProductPostingHistoryRepository(client),
      content,
      jobs,
      jobStats: jobs,
      marketplaceCatalogForWorkspace,
    },
    status: {
      niches,
      candidates,
      policies,
      content,
      attempts: new PrismaPublicationAttemptRepository(client),
      assets: new PrismaAssetRepository(client),
      jobStats: jobs,
      homeTokens: new PrismaHomeWorkerTokenRepository(client),
      affiliateLinkBuilderUrl: AFFILIATE_LINK_BUILDER_URL,
      ...settings,
    },
    counts: async (workspaceId) => ({
      offers: await client.offer.count({ where: { workspaceId } }),
      contentItems: await client.contentItem.count({ where: { workspaceId } }),
      publicationAttempts: await client.publicationAttempt.count({ where: { workspaceId } }),
    }),
  };
};
