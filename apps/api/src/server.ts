import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AppEnvironment, parseEnvironment } from "@money-maker/config";
import { COMMERCIAL_USE_BY_PROVIDER, createAsset } from "@money-maker/core/assets/asset";
import {
  cloudGenerationAllowed,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import { createStageCache } from "@money-maker/core/assets/stage-cache";
import { ensureCanonicalProduct } from "@money-maker/core/creatives/canonical-product";
import { pickScene } from "@money-maker/core/creatives/scene-bank";
import { decideSceneBudget } from "@money-maker/core/usage/generation-budget";
import { createCanvaDesignExporterForWorkspace } from "@money-maker/providers/canva/workspace-catalog";
import { createWorkersAiSceneGenerator } from "@money-maker/providers/cloudflare/workers-ai-scene-generator";
import { PrismaAssetRepository } from "@money-maker/providers/database/asset-repository";
import { PrismaAttributionRepository } from "@money-maker/providers/database/attribution-repository";
import { createPrismaAuthenticationRepository } from "@money-maker/providers/database/authentication-repository";
import { PrismaChannelRepository } from "@money-maker/providers/database/channel-repository";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaContentRepository } from "@money-maker/providers/database/content-repository";
import { PrismaContinuityRepository } from "@money-maker/providers/database/continuity-repository";
import { PrismaCostRepository } from "@money-maker/providers/database/cost-repository";
import { PrismaEditorialRepository } from "@money-maker/providers/database/editorial-repository";
import { PrismaEpisodeIdeaRepository } from "@money-maker/providers/database/episode-idea-repository";
import { aiGatewayCredits } from "@money-maker/providers/cloud-gpu/ai-gateway";
import { verifyModalCredentials } from "@money-maker/providers/cloud-gpu/modal-scene-clip-generator";
import { PrismaGenerationBudgetLedger } from "@money-maker/providers/database/generation-budget-ledger";
import { PrismaGenerationRouteRepository } from "@money-maker/providers/database/generation-route-repository";
import { PrismaGenerationSettingsRepository } from "@money-maker/providers/database/generation-settings-repository";
import { PrismaHomeWorkerTokenRepository } from "@money-maker/providers/database/home-worker-token-repository";
import { createInvitationDependencies } from "@money-maker/providers/database/invitation-dependencies";
import { PrismaLongFormRenderRepository } from "@money-maker/providers/database/long-form-render-repository";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";
import { PrismaOfferRepository } from "@money-maker/providers/database/offer-repository";
import { PrismaPerformanceRepository } from "@money-maker/providers/database/performance-repository";
import { PrismaProductCandidateRepository } from "@money-maker/providers/database/product-candidate-repository";
import { PrismaProductPostingHistoryRepository } from "@money-maker/providers/database/product-posting-history-repository";
import { PrismaProviderConnectionRepository } from "@money-maker/providers/database/provider-connection-repository";
import { PrismaPublicationPolicyRepository } from "@money-maker/providers/database/publication-policy-repository";
import { PrismaPublicationAttemptRepository } from "@money-maker/providers/database/publication-repository";
import { PrismaReelRenderRepository } from "@money-maker/providers/database/reel-render-repository";
import { PrismaResearchPolicyRepository } from "@money-maker/providers/database/research-policy-repository";
import { PrismaResearchRepository } from "@money-maker/providers/database/research-repository";
import { PrismaSecretRecordRepository } from "@money-maker/providers/database/secret-record-repository";
import { PrismaStoryboardRepository } from "@money-maker/providers/database/storyboard-repository";
import { PrismaUsageRepository } from "@money-maker/providers/database/usage-repository";
import { PrismaWebhookInboxRepository } from "@money-maker/providers/database/webhook-inbox-repository";
import { PrismaWorkspaceRepository } from "@money-maker/providers/database/workspace-repository";
import { reencodeImage } from "@money-maker/providers/http/fit-image";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { PostgresJobQueue } from "@money-maker/providers/jobs/postgres-job-queue";
import { createJevDecisionProvider } from "@money-maker/providers/llm/jev-decision-provider";
import { probeVideo, transcodeToMp4 } from "@money-maker/providers/media/clip-video";
import { compositeProduct } from "@money-maker/providers/media/composite-product";
import { classifyPicture } from "@money-maker/providers/media/picture-classifier";
import { postProcessPlate } from "@money-maker/providers/media/plate-postprocess";
import { proceduralScene } from "@money-maker/providers/media/procedural-scene";
import { colourEvidence, productColours } from "@money-maker/providers/media/sharp-colour-evidence";
import { referenceEvidence } from "@money-maker/providers/media/sharp-reference-evidence";
import { createSharpStoryImageComposer } from "@money-maker/providers/media/sharp-story-image-composer";
import { castSilhouettes } from "@money-maker/providers/media/silhouette-mask";
import { rasterizeSvg } from "@money-maker/providers/media/svg-rasterizer";
import { removeWhiteBackground } from "@money-maker/providers/media/white-background-remover";
import { resolveAffiliateLink } from "@money-maker/providers/mercado-livre/affiliate-link";
import { MercadoLivreCatalog } from "@money-maker/providers/mercado-livre/catalog";
import { createMercadoLivreClient } from "@money-maker/providers/mercado-livre/client";
import {
  createMarketplaceCatalogForWorkspace,
  createMercadoLivreClientForWorkspaceId,
} from "@money-maker/providers/mercado-livre/workspace-catalog";
import { createPostForMeClient } from "@money-maker/providers/post-for-me/client";
import { createPostForMePublisher } from "@money-maker/providers/post-for-me/social-publisher";
import { EncryptedSecretStore } from "@money-maker/providers/secrets/encrypted-secret-store";
import { R2AssetStore } from "@money-maker/providers/storage/r2-asset-store";
import { createR2S3SigningClient } from "@money-maker/providers/storage/r2-s3-signing-client";
import { createYouTubeDataApiClient } from "@money-maker/providers/youtube/data-api-client";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies, AuthDependencies } from "./app.js";
import { createAuthenticateRequest } from "./auth/authenticate-request.js";
import { createOidcSecurity, type OidcSecurity } from "./auth/oidc-client.js";

type ConfiguredAuthentication = Readonly<{
  security: OidcSecurity;
  issuer: string;
  webAppUrl: AuthDependencies["webAppUrl"];
  redirectUri: AuthDependencies["redirectUri"];
  sessionSecret: AuthDependencies["sessionSecret"];
  secureCookies: AuthDependencies["secureCookies"];
}>;

export const createApiDependencies = (
  databaseUrl: string,
  secretStoreMasterKey: Buffer,
  r2Configuration?: Readonly<{
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    signedUrlTtl: number;
  }>,
  authenticationConfiguration?: ConfiguredAuthentication,
): ApiDependencies => {
  const client = createDatabaseClient(databaseUrl);
  const invitation = createInvitationDependencies(client);
  const authentication = createPrismaAuthenticationRepository(client);
  const auth = authenticationConfiguration
    ? {
        authentication,
        oidcClient: authenticationConfiguration.security.oidcClient,
        tokenVerifier: authenticationConfiguration.security.tokenVerifier,
        webAppUrl: authenticationConfiguration.webAppUrl,
        redirectUri: authenticationConfiguration.redirectUri,
        sessionSecret: authenticationConfiguration.sessionSecret,
        secureCookies: authenticationConfiguration.secureCookies,
      }
    : undefined;
  const assetStore = r2Configuration
    ? new R2AssetStore(
        createR2S3SigningClient(r2Configuration),
        r2Configuration.bucketName,
        r2Configuration.signedUrlTtl,
      )
    : undefined;
  const assetRepository = new PrismaAssetRepository(client);
  const jobQueue = new PostgresJobQueue(client);
  const sceneGenerator =
    cloudGenerationAllowed(parseGenerationPolicy(process.env.GENERATION_POLICY)) &&
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.CLOUDFLARE_AI_GATEWAY
      ? createWorkersAiSceneGenerator({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          gateway: process.env.CLOUDFLARE_AI_GATEWAY,
        })
      : null;
  const sceneRequester = assetStore
    ? async (input: {
        workspaceId: import("@money-maker/contracts").WorkspaceId;
        nicheId: string;
        plan: import("@money-maker/core/creatives/scene-plan").ScenePlan;
        correlationId?: string;
      }) => {
        const picked = await pickScene(
          {
            assets: assetRepository,
            store: assetStore,
            generator: sceneGenerator,
            usage: new PrismaUsageRepository(client),
            budget: decideSceneBudget,
            now: () => new Date(),
          },
          {
            ...input,
            recentSceneIds: [],
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          },
        );
        if ("assetId" in picked) return picked;
        const bytes = await proceduralScene({
          width: 1280,
          height: 720,
          palette: { primary: "#172554", accent: "#38bdf8", surface: "#f8fafc", text: "#0f172a" },
        });
        const id = randomUUID();
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const creator = "money-maker:procedural-scene-v1";
        if (!COMMERCIAL_USE_BY_PROVIDER.has(creator))
          throw new Error("procedural_scene_rights_unavailable");
        const created = createAsset({
          id,
          workspaceId: input.workspaceId,
          mimeType: "image/png",
          checksum,
          byteSize: bytes.byteLength,
          width: 1280,
          height: 720,
          provenance: "generated",
          license: "Money Maker procedural scene v1",
          commercialUse: true,
          creator,
          metadata: { role: "scene", nicheId: input.nicheId, sceneKey: "procedural:v1" },
        });
        if (!created.ok) throw new Error("procedural_scene_invalid");
        await assetRepository.create(created.asset);
        try {
          await assetStore.putObject({
            workspaceId: input.workspaceId,
            assetId: id,
            mimeType: created.asset.mimeType,
            checksum,
            width: 1280,
            height: 720,
            bytes,
          });
        } catch (error) {
          await assetRepository.updateState({
            workspaceId: input.workspaceId,
            assetId: id,
            state: "archived",
          });
          throw error;
        }
        const active = await assetRepository.updateState({
          workspaceId: input.workspaceId,
          assetId: id,
          state: "active",
        });
        if (!active) throw new Error("procedural_scene_activation_failed");
        return { assetId: id, source: "procedural" as const };
      }
    : undefined;
  const canva =
    process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET
      ? { clientId: process.env.CANVA_CLIENT_ID, clientSecret: process.env.CANVA_CLIENT_SECRET }
      : undefined;
  return {
    authenticate: auth
      ? createAuthenticateRequest({ authentication, tokenVerifier: auth.tokenVerifier })
      : async () => null,
    ...(auth ? { auth } : {}),
    invitation,
    audit: invitation.audit,
    workspaces: new PrismaWorkspaceRepository(client),
    offerRepository: new PrismaOfferRepository(client),
    channelRepository: new PrismaChannelRepository(client),
    assetRepository,
    ...(assetStore ? { assetStore } : {}),
    storyImageComposer: createSharpStoryImageComposer(),
    sceneRasterizer: rasterizeSvg,
    silhouetteMasks: castSilhouettes,
    reelRenders: new PrismaReelRenderRepository(client),
    storyboardRepository: new PrismaStoryboardRepository(client),
    continuityRepository: new PrismaContinuityRepository(client),
    episodeIdeaRepository: new PrismaEpisodeIdeaRepository(client),
    longFormRenderRepository: new PrismaLongFormRenderRepository(client),
    ...(process.env.TTS_URL ? { longFormAvailable: true } : {}),
    // Off by default: needs a local_ai worker on the same queue (decision D4 is open).
    ...(process.env.SCENE_DIRECTION_ENABLED === "true" ? { sceneDirectionAvailable: true } : {}),
    ...(sceneRequester ? { requestStoryboardScene: sceneRequester } : {}),
    contentRepository: new PrismaContentRepository(client),
    publicationPolicyRepository: new PrismaPublicationPolicyRepository(client),
    nicheRepository: new PrismaNicheRepository(client),
    researchRepository: new PrismaResearchRepository(client),
    editorialRepository: new PrismaEditorialRepository(client),
    researchPolicyRepository: new PrismaResearchPolicyRepository(client),
    productCandidateRepository: new PrismaProductCandidateRepository(client),
    productPostingHistoryRepository: new PrismaProductPostingHistoryRepository(client),
    marketplaceCatalog: new MercadoLivreCatalog(createMercadoLivreClient()),
    ...(process.env.YOUTUBE_DATA_API_KEY
      ? {
          youtubeSourceDiscovery: createYouTubeDataApiClient({
            apiKey: process.env.YOUTUBE_DATA_API_KEY,
          }),
        }
      : {}),
    affiliateLinkResolver: (url) => resolveAffiliateLink(url),
    marketplaceCatalogForWorkspace: createMarketplaceCatalogForWorkspace({
      client,
      secretStoreMasterKey,
    }),
    mercadoLivreClientForWorkspace: createMercadoLivreClientForWorkspaceId({
      client,
      secretStoreMasterKey,
    }),
    ...(canva ? { canva } : {}),
    ...(canva
      ? {
          designExporterForWorkspace: createCanvaDesignExporterForWorkspace({
            client,
            secretStoreMasterKey,
            clientId: canva.clientId,
            clientSecret: canva.clientSecret,
          }),
        }
      : {}),
    costRepository: new PrismaCostRepository(client),
    attributionRepository: new PrismaAttributionRepository(client),
    performanceRepository: new PrismaPerformanceRepository(client),
    clickSalt: createHmac("sha256", secretStoreMasterKey).update("click-visitor").digest("hex"),
    providerConnections: new PrismaProviderConnectionRepository(client),
    generation: {
      settings: new PrismaGenerationSettingsRepository(client),
      ledger: new PrismaGenerationBudgetLedger(client),
      routes: new PrismaGenerationRouteRepository(client),
      verifyModalCredentials: (credentials) => verifyModalCredentials(credentials),
      aiGatewayCredits: (apiKey) => aiGatewayCredits(apiKey),
    },
    publicationAttempts: new PrismaPublicationAttemptRepository(client),
    jobQueue,
    jobStats: jobQueue,
    generationPolicy: parseGenerationPolicy(process.env.GENERATION_POLICY),
    autonomyEnabled: process.env.AUTONOMY_ENABLED !== "false",
    // Home worker task API (ADR 0012): needs the asset store for plates and frame downloads.
    ...(assetStore
      ? {
          homeWorker: {
            tokens: new PrismaHomeWorkerTokenRepository(client),
            tasks: {
              queue: new PostgresJobQueue(client),
              leaseDurationMs: 30 * 60 * 1000,
              routes: new PrismaGenerationRouteRepository(client),
              scripts: new PrismaEditorialRepository(client),
              content: new PrismaContentRepository(client),
              niches: new PrismaNicheRepository(client),
              storyboards: new PrismaStoryboardRepository(client),
              renders: new PrismaLongFormRenderRepository(client),
              assets: assetRepository,
              store: assetStore,
              bank: {
                assets: assetRepository,
                store: assetStore,
                usage: new PrismaUsageRepository(client),
                budget: () => "generate" as const,
                now: () => new Date(),
              },
              postProcess: postProcessPlate,
              offerCopy: {
                offers: new PrismaOfferRepository(client),
                channels: new PrismaChannelRepository(client),
                catalogForWorkspace: createMarketplaceCatalogForWorkspace({
                  client,
                  secretStoreMasterKey,
                }),
                build: {
                  contentRepository: new PrismaContentRepository(client),
                  offerRepository: new PrismaOfferRepository(client),
                  channelRepository: new PrismaChannelRepository(client),
                  jobQueue: new PostgresJobQueue(client),
                },
              },
              reencodeImage: (bytes: Uint8Array) => reencodeImage(bytes),
              // Reel narration check (speech_recognition): ASR transcript vs voice script.
              narration: {
                reels: new PrismaReelRenderRepository(client),
                variants: new PrismaContentRepository(client),
                assets: assetRepository,
                store: assetStore,
                now: () => new Date(),
              },
              // Auto-package scenes (plan D1/D2): FLUX.2 Klein at home, fidelity gate here.
              offerScenes: {
                offers: new PrismaOfferRepository(client),
                content: new PrismaContentRepository(client),
                assets: assetRepository,
                store: assetStore,
                jobs: new PostgresJobQueue(client),
                fetchBytes: async (url: string) =>
                  (
                    await fetchSafeMedia(new URL(url), {
                      maxBytes: 20_000_000,
                      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
                    })
                  ).bytes,
                productColours,
                colourEvidence,
                referenceEvidence,
                // Shot direction per slide template; opt-in until the owner judges a package.
                direction: process.env.OFFER_SCENE_DIRECTION === "on",
                // Real cut-out on a drawn backdrop for count-critical product-only slots (Phase 3);
                // opt-in with direction until the arena run qualifies it.
                ...(process.env.OFFER_SCENE_COMPOSITE === "on"
                  ? {
                      composite: {
                        canonical: (input) =>
                          ensureCanonicalProduct(
                            {
                              assets: assetRepository,
                              store: assetStore,
                              fetchBytes: async (url) =>
                                (
                                  await fetchSafeMedia(new URL(url), {
                                    maxBytes: 15_000_000,
                                    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
                                  })
                                ).bytes,
                              cutout: removeWhiteBackground,
                              classify: classifyPicture,
                            },
                            input,
                          ),
                        compose: compositeProduct,
                      },
                    }
                  : {}),
              },
              // Local Wan clips (spec 2026-10-02, decision 7): inert unless LOCAL_VIDEO_ENABLED.
              clips: {
                enabled: process.env.LOCAL_VIDEO_ENABLED === "true",
                model: process.env.VIDEO_GEN_MODEL?.trim() || "local:wan2.2-ti2v-5b",
                maxBytes: Number(process.env.LOCAL_AI_MAX_VIDEO_BYTES) || 50_000_000,
                maxFrames: Number(process.env.LOCAL_AI_MAX_VIDEO_FRAMES) || 33,
                storyboards: new PrismaStoryboardRepository(client),
                offers: new PrismaOfferRepository(client),
                clipState: new PrismaStoryboardRepository(client),
                cache: createStageCache({
                  assets: assetRepository,
                  store: assetStore,
                  fetchBytes: async (url) =>
                    (
                      await fetchSafeMedia(new URL(url), {
                        maxBytes: 100_000_000,
                        allowedMimeTypes: ["video/mp4"],
                      })
                    ).bytes,
                }),
                jobs: new PostgresJobQueue(client),
                probeVideo,
                toMp4: transcodeToMp4,
              },
              now: () => new Date(),
            },
          },
        }
      : {}),
    webhookInbox: new PrismaWebhookInboxRepository(client),
    postForMeClient: createPostForMeClient(),
    socialPublisherForWorkspace: (workspaceId) =>
      createPostForMePublisher({
        secretStore: new EncryptedSecretStore(
          new PrismaSecretRecordRepository(client, workspaceId),
          secretStoreMasterKey,
        ),
      }),
    secretStoreForWorkspace: (workspaceId) =>
      new EncryptedSecretStore(
        new PrismaSecretRecordRepository(client, workspaceId),
        secretStoreMasterKey,
      ),
    close: () => client.$disconnect(),
    ...(process.env.PUBLIC_API_URL ? { publicApiUrl: process.env.PUBLIC_API_URL } : {}),
    ...(process.env.MCP_RESOURCE_URL ? { mcpResourceUrl: process.env.MCP_RESOURCE_URL } : {}),
    ...(authenticationConfiguration ? { authIssuerUrl: authenticationConfiguration.issuer } : {}),
  };
};

const readAuthenticationConfiguration = async (
  environment: AppEnvironment,
): Promise<ConfiguredAuthentication | undefined> => {
  const values = [
    environment.AUTH_ISSUER_URL,
    environment.AUTH_CLIENT_ID,
    environment.AUTH_CLIENT_SECRET,
    environment.AUTH_AUDIENCE,
    environment.AUTH_REDIRECT_URI,
    environment.WEB_APP_URL,
    environment.SESSION_SECRET,
  ];
  const configured = values.filter((value) => value !== undefined && value.trim().length > 0);
  if (configured.length === 0) return undefined;
  if (configured.length !== values.length) {
    throw new Error(
      "Invalid authentication configuration. Set AUTH_ISSUER_URL, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_AUDIENCE, AUTH_REDIRECT_URI, WEB_APP_URL, and SESSION_SECRET together.",
    );
  }

  const sessionSecret = Buffer.from(environment.SESSION_SECRET ?? "", "base64url");
  if (sessionSecret.length !== 32) {
    throw new Error(
      "Invalid authentication configuration. SESSION_SECRET must be 32 bytes base64url.",
    );
  }
  const issuer = environment.AUTH_ISSUER_URL ?? "";
  const clientId = environment.AUTH_CLIENT_ID ?? "";
  const clientSecret = environment.AUTH_CLIENT_SECRET ?? "";
  const audience = environment.AUTH_AUDIENCE ?? "";
  const redirectUri = environment.AUTH_REDIRECT_URI ?? "";
  const webAppUrl = environment.WEB_APP_URL ?? "";
  const security = await createOidcSecurity({
    issuer,
    clientId,
    clientSecret,
    audience,
    redirectUri,
  });
  return {
    security,
    issuer,
    webAppUrl,
    redirectUri,
    sessionSecret,
    secureCookies: environment.NODE_ENV === "production",
  };
};

export const startServer = async (dependencies?: ApiDependencies): Promise<FastifyInstance> => {
  let environment: AppEnvironment;
  try {
    environment = parseEnvironment(process.env);
  } catch (error) {
    if (error instanceof Error && error.message.includes("generation_policy_invalid"))
      throw new Error("generation_policy_invalid");
    throw new Error(
      "Invalid environment configuration. Check DATABASE_URL and authentication settings.",
    );
  }
  console.info("generation_policy", { policy: environment.GENERATION_POLICY });

  const { buildApp } = await import("./app.js");
  let resolvedDependencies = dependencies;
  if (!resolvedDependencies) {
    const secretStoreMasterKey = process.env.SECRET_STORE_MASTER_KEY;
    if (!secretStoreMasterKey) {
      throw new Error(
        "Invalid environment configuration. Set SECRET_STORE_MASTER_KEY before starting the API.",
      );
    }
    const masterKey = Buffer.from(secretStoreMasterKey, "base64url");
    if (masterKey.length !== 32) {
      throw new Error(
        "Invalid environment configuration. SECRET_STORE_MASTER_KEY must be 32 bytes base64url.",
      );
    }
    const authenticationConfiguration = await readAuthenticationConfiguration(environment);
    resolvedDependencies = createApiDependencies(
      environment.DATABASE_URL,
      masterKey,
      environment.R2_ACCOUNT_ID &&
        environment.R2_ACCESS_KEY_ID &&
        environment.R2_SECRET_ACCESS_KEY &&
        environment.R2_BUCKET
        ? {
            accountId: environment.R2_ACCOUNT_ID,
            accessKeyId: environment.R2_ACCESS_KEY_ID,
            secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
            bucketName: environment.R2_BUCKET,
            signedUrlTtl: environment.R2_SIGNED_URL_TTL ?? 900,
          }
        : undefined,
      authenticationConfiguration,
    );
  }
  const app = buildApp({
    ...resolvedDependencies,
    ...(environment.JEV_ENABLED && environment.TYPESAFE_API_KEY
      ? {
          decisionProvider: createJevDecisionProvider({
            apiKey: environment.TYPESAFE_API_KEY,
            model: environment.JEV_MODEL,
            baseUrl: environment.JEV_BASE_URL,
          }),
        }
      : {}),
    logger: true,
  });
  try {
    await app.listen({ port: environment.PORT, host: environment.HOST ?? "127.0.0.1" });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
};

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  startServer()
    .then((app) => {
      const shutdown = () => {
        void app.close().catch(() => {
          console.error("API shutdown failed.");
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "API startup failed.");
      process.exitCode = 1;
    });
}
