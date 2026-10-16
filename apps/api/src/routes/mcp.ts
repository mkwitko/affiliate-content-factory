import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ApiDependencies } from "../app.js";
import { oauthScopes } from "../auth/oidc-token-verifier.js";
import { createMoneyMakerMcpServer } from "../mcp/server.js";

type McpRouteOptions = Readonly<{ dependencies: ApiDependencies }>;

const protectedResourceMetadataPath = "/.well-known/oauth-protected-resource";
// RFC 9728 path-inserted location for the `/mcp` resource; the root path stays for older clients.
const mcpProtectedResourceMetadataPath = `${protectedResourceMetadataPath}/mcp`;

const resourceUrl = (dependencies: ApiDependencies): string | undefined =>
  dependencies.mcpResourceUrl ??
  (dependencies.publicApiUrl ? `${dependencies.publicApiUrl.replace(/\/$/, "")}/mcp` : undefined);

const unauthorizedChallenge = (resource: string | undefined): string => {
  const metadata = resource
    ? `, resource_metadata="${new URL(mcpProtectedResourceMetadataPath, resource).toString()}"`
    : "";
  return `Bearer error="invalid_token", error_description="Authentication required"${metadata}`;
};

export const mcpSharedDependencies = (dependencies: ApiDependencies) => ({
  invitation: dependencies.invitation,
  workspaces: dependencies.workspaces,
  ...(dependencies.nicheRepository ? { nicheRepository: dependencies.nicheRepository } : {}),
  ...(dependencies.researchRepository
    ? { researchRepository: dependencies.researchRepository }
    : {}),
  ...(dependencies.editorialRepository
    ? { editorialRepository: dependencies.editorialRepository }
    : {}),
  ...(dependencies.continuityRepository
    ? { continuityRepository: dependencies.continuityRepository }
    : {}),
  ...(dependencies.episodeIdeaRepository
    ? { episodeIdeaRepository: dependencies.episodeIdeaRepository }
    : {}),
  ...(dependencies.homeWorker ? { homeWorkerTokens: dependencies.homeWorker.tokens } : {}),
  ...(dependencies.generation
    ? {
        generationSettings: dependencies.generation.settings,
        generationBudgetLedger: dependencies.generation.ledger,
        generationRoutes: dependencies.generation.routes,
        verifyModalCredentials: dependencies.generation.verifyModalCredentials,
        aiGatewayCredits: dependencies.generation.aiGatewayCredits,
      }
    : {}),
  ...(dependencies.researchPolicyRepository
    ? { researchPolicyRepository: dependencies.researchPolicyRepository }
    : {}),
  ...(dependencies.productCandidateRepository
    ? { productCandidateRepository: dependencies.productCandidateRepository }
    : {}),
  ...(dependencies.productPostingHistoryRepository
    ? { productPostingHistoryRepository: dependencies.productPostingHistoryRepository }
    : {}),
  ...(dependencies.marketplaceCatalog
    ? { marketplaceCatalog: dependencies.marketplaceCatalog }
    : {}),
  ...(dependencies.marketplaceCatalogForWorkspace
    ? { marketplaceCatalogForWorkspace: dependencies.marketplaceCatalogForWorkspace }
    : {}),
  ...(dependencies.youtubeSourceDiscovery
    ? { youtubeSourceDiscovery: dependencies.youtubeSourceDiscovery }
    : {}),
  ...(dependencies.affiliateLinkResolver
    ? { affiliateLinkResolver: dependencies.affiliateLinkResolver }
    : {}),
  ...(dependencies.costRepository ? { costRepository: dependencies.costRepository } : {}),
  ...(dependencies.attributionRepository
    ? { attributionRepository: dependencies.attributionRepository }
    : {}),
  ...(dependencies.publicApiUrl ? { publicApiUrl: dependencies.publicApiUrl } : {}),
  ...(dependencies.performanceRepository
    ? { performanceRepository: dependencies.performanceRepository }
    : {}),
  ...(dependencies.providerConnections
    ? { providerConnections: dependencies.providerConnections }
    : {}),
  ...(dependencies.secretStore ? { secretStore: dependencies.secretStore } : {}),
  ...(dependencies.secretStoreForWorkspace
    ? { secretStoreForWorkspace: dependencies.secretStoreForWorkspace }
    : {}),
  ...(dependencies.offerRepository ? { offerRepository: dependencies.offerRepository } : {}),
  ...(dependencies.audit ? { audit: dependencies.audit } : {}),
  ...(dependencies.contentRepository ? { contentRepository: dependencies.contentRepository } : {}),
  ...(dependencies.channelRepository ? { channelRepository: dependencies.channelRepository } : {}),
  ...(dependencies.assetRepository ? { assetRepository: dependencies.assetRepository } : {}),
  ...(dependencies.assetStore ? { assetStore: dependencies.assetStore } : {}),
  ...(dependencies.storyImageComposer
    ? { storyImageComposer: dependencies.storyImageComposer }
    : {}),
  ...(dependencies.silhouetteMasks ? { silhouetteMasks: dependencies.silhouetteMasks } : {}),
  ...(dependencies.sceneRasterizer ? { sceneRasterizer: dependencies.sceneRasterizer } : {}),
  ...(dependencies.reelRenders ? { reelRenders: dependencies.reelRenders } : {}),
  ...(dependencies.storyboardRepository
    ? { storyboardRepository: dependencies.storyboardRepository }
    : {}),
  ...(dependencies.longFormRenderRepository
    ? { longFormRenderRepository: dependencies.longFormRenderRepository }
    : {}),
  ...(dependencies.longFormAvailable ? { longFormAvailable: true } : {}),
  ...(dependencies.sceneDirectionAvailable ? { sceneDirectionAvailable: true } : {}),
  ...(dependencies.requestStoryboardScene
    ? { requestStoryboardScene: dependencies.requestStoryboardScene }
    : {}),
  ...(dependencies.publicationPolicyRepository
    ? { publicationPolicyRepository: dependencies.publicationPolicyRepository }
    : {}),
  ...(dependencies.publicationAttempts
    ? { publicationAttempts: dependencies.publicationAttempts }
    : {}),
  ...(dependencies.jobQueue ? { jobQueue: dependencies.jobQueue } : {}),
  ...(dependencies.jobStats ? { jobStats: dependencies.jobStats } : {}),
  ...(dependencies.generationPolicy ? { generationPolicy: dependencies.generationPolicy } : {}),
  ...(dependencies.autonomyEnabled ? { autonomyEnabled: true } : {}),
  ...(dependencies.socialPublisherForWorkspace
    ? { socialPublisherForWorkspace: dependencies.socialPublisherForWorkspace }
    : {}),
  ...(dependencies.postForMeClient ? { postForMeClient: dependencies.postForMeClient } : {}),
  ...(dependencies.designExporterForWorkspace
    ? { designExporterForWorkspace: dependencies.designExporterForWorkspace }
    : {}),
});

export const registerMcpRoute = async (
  app: FastifyInstance,
  options: McpRouteOptions,
): Promise<void> => {
  const sharedDependencies = mcpSharedDependencies(options.dependencies);

  for (const path of [mcpProtectedResourceMetadataPath, protectedResourceMetadataPath]) {
    app.get(path, async (_request, reply) => {
      const resource = resourceUrl(options.dependencies);
      if (!resource) return reply.code(404).send();
      return reply.send({
        resource,
        authorization_servers: options.dependencies.authIssuerUrl
          ? [options.dependencies.authIssuerUrl]
          : [],
        scopes_supported: oauthScopes,
      });
    });
  }

  // Authenticate in onRequest so unauthenticated clients get the OAuth challenge
  // even when their body is empty or malformed (parsing happens later).
  const authentications = new WeakMap<
    object,
    NonNullable<Awaited<ReturnType<ApiDependencies["authenticate"]>>>
  >();
  app.post(
    "/mcp",
    {
      onRequest: async (request, reply) => {
        const authentication = await options.dependencies.authenticate(request);
        if (!authentication) {
          request.log.info(
            { hasAuthorization: request.headers.authorization !== undefined },
            "mcp unauthorized",
          );
          return reply
            .code(401)
            .header("www-authenticate", unauthorizedChallenge(resourceUrl(options.dependencies)))
            .type("application/json")
            .send({ error: "unauthorized" });
        }
        authentications.set(request, authentication);
      },
    },
    async (request, reply) => {
      const authentication = authentications.get(request);
      if (!authentication) return reply.code(401).send({ error: "unauthorized" });

      const server = createMoneyMakerMcpServer({
        ...sharedDependencies,
        logToolError: (tool, error) => request.log.error({ err: error, tool }, "mcp tool failed"),
        authenticate: async () => ({
          userId: authentication.userId,
          verifiedEmail: authentication.verifiedEmail,
          ...(authentication.scopes ? { scopes: authentication.scopes } : {}),
        }),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

      reply.hijack();
      try {
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json");
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "Internal server error" },
            }),
          );
        }
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  );
};
