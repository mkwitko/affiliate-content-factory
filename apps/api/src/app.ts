import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { StoryImageComposer } from "@money-maker/core/assets/story-image-composer";
import type { ReelRenderRepository } from "@money-maker/core/publishing/reel-render";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type { ResearchPolicyRepository } from "@money-maker/core/research/research-policy-repository";
import type { ProductCandidateRepository } from "@money-maker/core/research/product-candidate-repository";
import type { ProductPostingHistoryRepository } from "@money-maker/core/offers/product-posting-history";
import type { MarketplaceCatalog } from "@money-maker/core/offers/marketplace-catalog";
import type { CostRepository } from "@money-maker/core/costs/cost-repository";
import type { AttributionRepository } from "@money-maker/core/analytics/attribution-repository";
import type { AuditPort } from "@money-maker/core/audit/audit-port";
import type { AuthenticationRepository } from "@money-maker/core/identity/authentication-repository";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerMcpRoute } from "./routes/mcp.js";
import { registerProviderConnectionRoutes } from "./routes/provider-connections.js";
import { registerMercadoLivreConnectionRoutes } from "./routes/mercado-livre-connections.js";
import { registerCanvaConnectionRoutes } from "./routes/canva-connections.js";
import { registerAffiliateLinkRoutes } from "./routes/affiliate-links.js";
import { registerFailedJobRoutes } from "./routes/failed-jobs.js";
import { registerOfferRoutes } from "./routes/offers.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { sendError, unexpectedError } from "./http/errors.js";
import type { OidcClient } from "./auth/oidc-client.js";
import type { OidcTokenVerifier } from "./auth/oidc-token-verifier.js";
import type { OAuthScope } from "./auth/oidc-token-verifier.js";
import type { JobQueue } from "@money-maker/core/jobs/job";
import type { PublicationAttemptRepository } from "@money-maker/core/publishing/publication";
import type { SocialPublisher } from "@money-maker/core/publishing/social-publisher";
import type { WebhookInboxRepository } from "@money-maker/core/providers/webhook-inbox-repository";
import type { PostForMeClient } from "@money-maker/providers/post-for-me/client";
import type { MercadoLivreClient } from "@money-maker/providers/mercado-livre/client";
import type { DesignExporter } from "@money-maker/core/assets/design-exporter";
import { registerPublicationRoutes } from "./routes/publications.js";
import { registerPostForMeWebhookRoutes } from "./routes/post-for-me-webhooks.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerOperatorWorkspaceRoutes } from "./routes/operator-workspace.js";
import { registerPanelRoutes } from "./routes/panel.js";
import { registerNicheRoutes } from "./routes/niches.js";
import { registerTrackedRedirectRoutes } from "./routes/tracked-redirect.js";
import { registerHomeWorkerRoutes } from "./routes/home-worker.js";

export type TrustedAuthenticationContext = Readonly<{
  userId: UserId;
  verifiedEmail: string;
  scopes?: ReadonlySet<OAuthScope>;
}>;

export type AuthenticateRequest = (
  request?: FastifyRequest,
) => Promise<TrustedAuthenticationContext | null>;

export type AuthDependencies = Readonly<{
  authentication: AuthenticationRepository;
  oidcClient: OidcClient;
  tokenVerifier: OidcTokenVerifier;
  webAppUrl: string;
  redirectUri: string;
  sessionSecret: Uint8Array;
  secureCookies: boolean;
}>;

export type ApiDependencies = Readonly<{
  invitation: InvitationDependencies;
  workspaces: WorkspaceRepository;
  providerConnections?: ProviderConnectionRepository;
  secretStore?: SecretStore;
  secretStoreForWorkspace?: (
    workspaceId: import("@money-maker/contracts").WorkspaceId,
  ) => SecretStore;
  offerRepository?: OfferRepository;
  channelRepository?: ChannelRepository;
  assetRepository?: AssetRepository;
  assetStore?: AssetStore;
  storyImageComposer?: StoryImageComposer;
  sceneRasterizer?: NonNullable<import("./mcp/server.js").McpDependencies["sceneRasterizer"]>;
  silhouetteMasks?: NonNullable<import("./mcp/server.js").McpDependencies["silhouetteMasks"]>;
  reelRenders?: ReelRenderRepository;
  storyboardRepository?: import("@money-maker/core/content/storyboard-repository").StoryboardRepository;
  continuityRepository?: import("@money-maker/core/story/continuity").ContinuityRepository;
  episodeIdeaRepository?: import("@money-maker/core/youtube/episode-idea-repository").EpisodeIdeaRepository;
  /** Home worker task API (ADR 0012): token store and the server-side task use cases. */
  homeWorker?: Readonly<{
    tokens: import("@money-maker/core/home-worker/tokens").HomeWorkerTokenRepository;
    tasks: import("@money-maker/core/home-worker/tasks").HomeTaskDeps;
  }>;
  /** Generation money settings and cloud connections (spec 2026-10-14, orchestrator A). */
  generation?: Readonly<{
    settings: import("@money-maker/core/costs/generation-settings").GenerationSettingsRepository;
    ledger: import("@money-maker/core/costs/generation-budget").GenerationBudgetLedger;
    routes: import("@money-maker/core/generation/route-repository").GenerationRouteRepository;
    verifyModalCredentials: NonNullable<
      import("./mcp/server.js").McpDependencies["verifyModalCredentials"]
    >;
    aiGatewayCredits: NonNullable<import("./mcp/server.js").McpDependencies["aiGatewayCredits"]>;
  }>;
  longFormRenderRepository?: import("@money-maker/core/publishing/long-form-render").LongFormRenderRepository;
  longFormAvailable?: boolean;
  sceneDirectionAvailable?: boolean;
  requestStoryboardScene?: (input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    plan: import("@money-maker/core/creatives/scene-plan").ScenePlan;
    correlationId?: string;
  }) => Promise<Readonly<{ assetId: string; source: "bank" | "generated" | "procedural" }>>;
  contentRepository?: ContentRepository;
  publicationPolicyRepository?: PublicationPolicyRepository;
  publicationAttempts?: PublicationAttemptRepository;
  jobQueue?: JobQueue;
  jobStats?: import("@money-maker/core/jobs/job-stats").JobStats;
  generationPolicy?: string;
  autonomyEnabled?: boolean;
  socialPublisherForWorkspace?: (workspaceId: WorkspaceId) => SocialPublisher;
  webhookInbox?: WebhookInboxRepository;
  postForMeClient?: PostForMeClient;
  mercadoLivreClientForWorkspace?: (workspaceId: WorkspaceId) => MercadoLivreClient;
  /** Global Canva app credentials (unlike Mercado Livre, not per-workspace). */
  canva?: Readonly<{ clientId: string; clientSecret: string }>;
  designExporterForWorkspace?: (workspaceId: WorkspaceId) => DesignExporter;
  publicApiUrl?: string;
  mcpResourceUrl?: string;
  authIssuerUrl?: string;
  nicheRepository?: NicheRepository;
  researchRepository?: ResearchRepository;
  editorialRepository?: import("@money-maker/core/content/editorial-repository").EditorialRepository;
  researchPolicyRepository?: ResearchPolicyRepository;
  productCandidateRepository?: ProductCandidateRepository;
  productPostingHistoryRepository?: ProductPostingHistoryRepository;
  marketplaceCatalog?: MarketplaceCatalog;
  marketplaceCatalogForWorkspace?: (workspaceId: WorkspaceId) => MarketplaceCatalog;
  youtubeSourceDiscovery?: import("@money-maker/core/research/youtube-discovery").YouTubeSourceDiscovery;
  affiliateLinkResolver?: import("@money-maker/providers/mercado-livre/affiliate-link").AffiliateLinkResolver;
  costRepository?: CostRepository;
  attributionRepository?: AttributionRepository;
  performanceRepository?: import("@money-maker/core/analytics/performance").PerformanceRepository;
  /** Server secret mixed into the daily visitor hash of tracked clicks. */
  clickSalt?: string;
  audit?: AuditPort;
  decisionProvider?: import("@money-maker/core/decisions/jev-shadow").DecisionProvider;
  authenticate: AuthenticateRequest;
  logger?: boolean;
  auth?: AuthDependencies;
  close?: () => Promise<void>;
}>;

export const buildApp = (dependencies: ApiDependencies): FastifyInstance => {
  const app = Fastify({
    // Request logging stays off: OAuth callback URLs carry authorization codes.
    logger: dependencies.logger ?? false,
    disableRequestLogging: true,
  });
  if (dependencies.close) app.addHook("onClose", dependencies.close);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, {
        code: error.code ?? "BAD_REQUEST",
        message: "The request could not be processed",
      });
    }
    request.log.error({ err: error }, "unhandled request error");
    return unexpectedError(reply);
  });

  void app.register(registerHealthRoute);
  void app.register(registerMeRoutes, { dependencies });
  void app.register(registerOperatorWorkspaceRoutes, { dependencies });
  void app.register(registerPanelRoutes, { dependencies });
  void app.register(registerNicheRoutes, { dependencies });
  if (dependencies.attributionRepository)
    void app.register(registerTrackedRedirectRoutes, {
      attributionRepository: dependencies.attributionRepository,
      ...(dependencies.assetStore ? { assetStore: dependencies.assetStore } : {}),
      ...(dependencies.clickSalt ? { clickSalt: dependencies.clickSalt } : {}),
      ...(dependencies.publicApiUrl ? { publicApiUrl: dependencies.publicApiUrl } : {}),
      ...(dependencies.auth?.webAppUrl ? { webAppUrl: dependencies.auth.webAppUrl } : {}),
    });
  if (dependencies.auth) void app.register(registerAuthRoutes, { dependencies });
  void app.register(registerInvitationRoutes, { dependencies });
  void app.register(registerMcpRoute, { dependencies });
  void app.register(registerProviderConnectionRoutes, { dependencies });
  void app.register(registerMercadoLivreConnectionRoutes, { dependencies });
  void app.register(registerCanvaConnectionRoutes, { dependencies });
  void app.register(registerOfferRoutes, { dependencies });
  void app.register(registerAffiliateLinkRoutes, { dependencies });
  void app.register(registerFailedJobRoutes, { dependencies });
  void app.register(registerAssetRoutes, { dependencies });
  void app.register(registerContentRoutes, { dependencies });
  void app.register(registerApprovalRoutes, { dependencies });
  void app.register(registerPublicationRoutes, { dependencies });
  void app.register(registerPostForMeWebhookRoutes, { dependencies });
  void app.register(registerHomeWorkerRoutes, { dependencies });

  return app;
};
