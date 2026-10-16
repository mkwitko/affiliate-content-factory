import type { AutonomyCycleDeps } from "@money-maker/core/autonomy/cycle";
import type { AutonomyStatusDeps } from "@money-maker/core/autonomy/status";
import type { WorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { mercadoLivreAffiliateLinkBuilderUrl } from "./search-mercado-livre-products.js";

const missing = () => new Error("Autonomy dependencies are not configured.");

export const autonomyCycleDeps = (deps: McpDependencies): AutonomyCycleDeps => {
  const catalog = deps.marketplaceCatalogForWorkspace;
  if (
    !deps.nicheRepository ||
    !deps.researchPolicyRepository ||
    !deps.productCandidateRepository ||
    !deps.offerRepository ||
    !deps.productPostingHistoryRepository ||
    !deps.contentRepository ||
    !deps.jobQueue ||
    !(catalog || deps.marketplaceCatalog)
  )
    throw missing();
  return {
    niches: deps.nicheRepository,
    policies: deps.researchPolicyRepository,
    candidates: deps.productCandidateRepository,
    offers: deps.offerRepository,
    postingHistory: deps.productPostingHistoryRepository,
    content: deps.contentRepository,
    jobs: deps.jobQueue,
    ...(deps.jobStats ? { jobStats: deps.jobStats } : {}),
    marketplaceCatalogForWorkspace: (workspaceId: WorkspaceId) =>
      catalog?.(workspaceId) ??
      (deps.marketplaceCatalog as NonNullable<typeof deps.marketplaceCatalog>),
  };
};

export const humanActionDeps = (
  deps: McpDependencies,
): Omit<AutonomyStatusDeps, "generationPolicy" | "autonomyEnabled" | "policies"> => {
  if (
    !deps.nicheRepository ||
    !deps.productCandidateRepository ||
    !deps.contentRepository ||
    !deps.publicationAttempts ||
    !deps.assetRepository
  )
    throw missing();
  return {
    niches: deps.nicheRepository,
    candidates: deps.productCandidateRepository,
    content: deps.contentRepository,
    attempts: deps.publicationAttempts,
    assets: deps.assetRepository,
    ...(deps.jobStats ? { jobStats: deps.jobStats } : {}),
    ...(deps.homeWorkerTokens ? { homeTokens: deps.homeWorkerTokens } : {}),
    affiliateLinkBuilderUrl: mercadoLivreAffiliateLinkBuilderUrl,
  };
};

export const statusDeps = (deps: McpDependencies): AutonomyStatusDeps => {
  if (!deps.researchPolicyRepository) throw missing();
  return {
    ...humanActionDeps(deps),
    policies: deps.researchPolicyRepository,
    generationPolicy: deps.generationPolicy ?? "cloud_allowed",
    autonomyEnabled: deps.autonomyEnabled ?? false,
  };
};
