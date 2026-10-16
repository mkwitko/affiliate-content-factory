import { setPriority, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWorkerEnvironment } from "@money-maker/config";
import { parseWorkspaceId } from "@money-maker/contracts";
import { runDueMetricSyncs } from "@money-maker/core/analytics/performance";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  cloudGenerationAllowed,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import { createStageCache } from "@money-maker/core/assets/stage-cache";
import { ensureCanonicalProduct } from "@money-maker/core/creatives/canonical-product";
import { PROVISIONAL_SEGMENT_MIN_CONFIDENCE } from "@money-maker/core/creatives/cutout-qa";
import { PROVISIONAL_FIDELITY_THRESHOLDS } from "@money-maker/core/creatives/product-fidelity";
import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import { pickScene } from "@money-maker/core/creatives/scene-bank";
import { routeId } from "@money-maker/core/generation/routing";
import {
  createWorker,
  type JobHandler,
  type JobWorker,
  PermanentJobError,
  RetryLaterJobError,
} from "@money-maker/core/jobs/job";
import { refreshActiveOffers } from "@money-maker/core/offers/refresh-offers";
import { requestAutoReels } from "@money-maker/core/publishing/auto-reels";
import { runDueResearchPolicies } from "@money-maker/core/research/run-research-policies";
import { decideSceneBudget } from "@money-maker/core/usage/generation-budget";
import {
  createModalCalls,
  createModalSceneClipGenerator,
  createR2ClipObjectStore,
  MODAL_PILOT,
} from "@money-maker/providers/cloud-gpu/modal-scene-clip-generator";
import { fetchPtaxUsdBrl } from "@money-maker/providers/cloud-gpu/ptax";
import { PrismaAssetRepository } from "@money-maker/providers/database/asset-repository";
import { PrismaAttributionRepository } from "@money-maker/providers/database/attribution-repository";
import { PrismaChannelRepository } from "@money-maker/providers/database/channel-repository";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaContentRepository } from "@money-maker/providers/database/content-repository";
import { PrismaCostRepository } from "@money-maker/providers/database/cost-repository";
import { PrismaEditorialRepository } from "@money-maker/providers/database/editorial-repository";
import { PrismaGenerationBudgetLedger } from "@money-maker/providers/database/generation-budget-ledger";
import { PrismaGenerationRouteRepository } from "@money-maker/providers/database/generation-route-repository";
import { PrismaGenerationSettingsRepository } from "@money-maker/providers/database/generation-settings-repository";
import { PrismaHomeWorkerTokenRepository } from "@money-maker/providers/database/home-worker-token-repository";
import { createPrismaAuditPort } from "@money-maker/providers/database/invitation-dependencies";
import { PrismaLongFormRenderRepository } from "@money-maker/providers/database/long-form-render-repository";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";
import { PrismaOfferRepository } from "@money-maker/providers/database/offer-repository";
import { PrismaPerformanceRepository } from "@money-maker/providers/database/performance-repository";
import { PrismaProductCandidateRepository } from "@money-maker/providers/database/product-candidate-repository";
import { PrismaProviderConnectionRepository } from "@money-maker/providers/database/provider-connection-repository";
import { PrismaPublicationPolicyRepository } from "@money-maker/providers/database/publication-policy-repository";
import { PrismaPublicationAttemptRepository } from "@money-maker/providers/database/publication-repository";
import { PrismaReelRenderRepository } from "@money-maker/providers/database/reel-render-repository";
import { PrismaResearchPolicyRepository } from "@money-maker/providers/database/research-policy-repository";
import { PrismaSecretRecordRepository } from "@money-maker/providers/database/secret-record-repository";
import { PrismaStoryboardRepository } from "@money-maker/providers/database/storyboard-repository";
import { PrismaUsageRepository } from "@money-maker/providers/database/usage-repository";
import { PrismaWorkspaceRepository } from "@money-maker/providers/database/workspace-repository";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { PostgresJobQueue } from "@money-maker/providers/jobs/postgres-job-queue";
import {
  createLlamaServerFrameReviewer,
  readFrameReviewerConfig,
} from "@money-maker/providers/llm/llama-server-frame-reviewer";
import {
  createLlamaServerSceneDirector,
  readSceneDirectorConfig,
} from "@money-maker/providers/llm/llama-server-scene-director";
import {
  createAgnesSceneClipGenerator,
  resolveAgnesModel,
} from "@money-maker/providers/media/agnes-scene-clip-generator";
import { extractLoopFrames } from "@money-maker/providers/media/ambient-loop";
import { renderStaticZoomClip } from "@money-maker/providers/media/clip-video";
import { createCommandImageSegmenter } from "@money-maker/providers/media/command-image-segmenter";
import {
  renderCreativeRendererSelfCheck,
  verifyCreativeRendererOutput,
} from "@money-maker/providers/media/creative-renderer-self-check";
import { extractKeyFrames } from "@money-maker/providers/media/extract-key-frames";
import { createFfmpegOwnedClipRenderer } from "@money-maker/providers/media/ffmpeg-owned-clip-renderer";
import { createFfmpegReelRenderer } from "@money-maker/providers/media/ffmpeg-reel-renderer";
import { createFolderMusicLibrary } from "@money-maker/providers/media/folder-music-library";
import { assertFontsPresent } from "@money-maker/providers/media/fonts";
import { createVisualQa } from "@money-maker/providers/media/frame-metrics";
import { renderParallaxSlide } from "@money-maker/providers/media/parallax-clip";
import { classifyPicture } from "@money-maker/providers/media/picture-classifier";
import { postProcessPlate } from "@money-maker/providers/media/plate-postprocess";
import { checkSceneClip } from "@money-maker/providers/media/scene-clip-check";
import { measureContrast } from "@money-maker/providers/media/sharp-contrast-measurer";
import { createSharpCreativeRenderer } from "@money-maker/providers/media/sharp-creative-renderer";
import { createSharpFidelityMeasurer } from "@money-maker/providers/media/sharp-fidelity-measurer";
import { createStickmanMotionRenderer } from "@money-maker/providers/media/stickman-motion-renderer";
import { limitImageThreads, rasterizeSvg } from "@money-maker/providers/media/svg-rasterizer";
import {
  applyMask,
  removeWhiteBackground,
} from "@money-maker/providers/media/white-background-remover";
import { createMarketplaceCatalogForWorkspace } from "@money-maker/providers/mercado-livre/workspace-catalog";
import { createPostForMePublisher } from "@money-maker/providers/post-for-me/social-publisher";
import { EncryptedSecretStore } from "@money-maker/providers/secrets/encrypted-secret-store";
import type { R2SigningClient } from "@money-maker/providers/storage/r2-asset-store";
import { R2AssetStore } from "@money-maker/providers/storage/r2-asset-store";
import { createR2S3SigningClient } from "@money-maker/providers/storage/r2-s3-signing-client";
import { buildAutonomyDeps } from "./autonomy-deps.js";
import { autonomyLoops } from "./autonomy-loop.js";
import { modalSetupFor } from "./cloud-connections.js";
import { createCloudWorker } from "./cloud-worker.js";
import { verifyModels } from "./commands/verify-models.js";
import { clipRunOutcome, shadowChoice } from "./generation-shadow.js";
import { createDirectScenesHandler } from "./handlers/direct-scenes.js";
import { createGeneratePlatesHandler } from "./handlers/generate-plates.js";
import {
  createGenerateSceneClipsHandler,
  type GenerateSceneClipsDependencies,
} from "./handlers/generate-scene-clips.js";
import { createProduceOfferPackageHandler } from "./handlers/produce-offer-package.js";
import { createPublishContentHandler } from "./handlers/publish-content.js";
import { createReconcilePublicationHandler } from "./handlers/reconcile-publication.js";
import { assertRendererReady, createRenderCreativesHandler } from "./handlers/render-creatives.js";
import { createRenderLongFormHandler } from "./handlers/render-long-form.js";
import { createRenderOwnedClipHandler } from "./handlers/render-owned-clip.js";
import { createRenderReelHandler } from "./handlers/render-reel.js";
import { createReviewFramesHandler } from "./handlers/review-frames.js";
import {
  type RenderLimits,
  readLocalAiLimits,
  readRenderLimits,
  sweepRenderTemp,
} from "./render-limits.js";
import {
  agnesApiKeyFor,
  cloudGpuProvidersFor,
  localVideoFor,
  sceneGeneratorFor,
} from "./scene-generator.js";
import { buildSpeechSynthesizer } from "./speech-wiring.js";
import {
  assertLeaseFitsReelReset,
  assertLocalAiDatabase,
  type Capabilities,
  detectCapabilities,
  selectHandlers,
  type WorkerProfile,
} from "./worker-profile.js";

export type WorkerDependencies = Readonly<{
  worker: JobWorker;
  /** Maintenance sweeps (research, metrics, offer refresh); none on a render_only worker. */
  loops: readonly JobWorker[];
  close: () => Promise<void>;
}>;

const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A minimal poll-and-sleep loop, the same shape `createWorker` already uses for the job
 * queue. No cron dependency: each tick calls `run` once and sleeps; a failed tick is logged
 * and does not stop the loop. The sleep is abortable so `requestStop` (SIGTERM/SIGINT) wakes
 * the loop immediately instead of waiting out the full interval.
 */
export const createPollingLoop = (input: {
  run: () => Promise<void>;
  intervalMs: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}): JobWorker => {
  let stopRequested = false;
  const controller = new AbortController();
  const sleep = input.sleep ?? defaultSleep;
  return {
    requestStop: () => {
      stopRequested = true;
      controller.abort();
    },
    run: async () => {
      while (!stopRequested) {
        try {
          await input.run();
        } catch (error) {
          input.onError?.(error);
        }
        if (!stopRequested) await sleep(input.intervalMs, controller.signal);
      }
    },
  };
};

export const createWorkerDependencies = (
  databaseUrl: string,
  secretStoreMasterKey: Buffer,
  assetStore?: AssetStore,
  sceneGenerator: SceneGenerator | null = null,
  limits: RenderLimits = readRenderLimits({}),
  selection: Readonly<{
    profile: WorkerProfile;
    jobs?: readonly string[] | undefined;
    capabilities: Capabilities;
  }> = {
    profile: "full",
    capabilities: {
      ffmpeg: true,
      tts: Boolean(process.env.TTS_URL),
      scene_clips:
        Boolean(agnesApiKeyFor(process.env)) ||
        localVideoFor(process.env) ||
        cloudGpuProvidersFor(process.env).includes("modal"),
    },
  },
  /** Presigns the Modal pilot's clip output URLs; absent leaves Modal clips off. */
  r2Signing?: R2SigningClient,
): WorkerDependencies => {
  const threads = limits.threads !== undefined ? { threads: limits.threads } : {};
  const client = createDatabaseClient(databaseUrl);
  const contentRepository = new PrismaContentRepository(client);
  const offerRepository = new PrismaOfferRepository(client);
  const channelRepository = new PrismaChannelRepository(client);
  const nicheRepository = new PrismaNicheRepository(client);
  const assetRepository = new PrismaAssetRepository(client);
  const marketplaceCatalogForWorkspace = createMarketplaceCatalogForWorkspace({
    client,
    secretStoreMasterKey,
  });
  const publishContent = createPublishContentHandler({
    attempts: new PrismaPublicationAttemptRepository(client),
    content: contentRepository,
    offers: offerRepository,
    catalogForWorkspace: marketplaceCatalogForWorkspace,
    channels: new PrismaChannelRepository(client),
    connections: new PrismaProviderConnectionRepository(client),
    policies: new PrismaPublicationPolicyRepository(client),
    attributionRepository: new PrismaAttributionRepository(client),
    ...(process.env.PUBLIC_API_URL ? { publicApiUrl: process.env.PUBLIC_API_URL } : {}),
    ...(assetStore ? { assets: assetStore } : {}),
    assetRepository,
    editorialRepository: new PrismaEditorialRepository(client),
    jobs: new PostgresJobQueue(client),
    publisher: (workspaceId) =>
      createPostForMePublisher({
        secretStore: new EncryptedSecretStore(
          new PrismaSecretRecordRepository(client, workspaceId),
          secretStoreMasterKey,
        ),
      }),
  });
  const publisherForWorkspace = (workspaceId: import("@money-maker/contracts").WorkspaceId) =>
    createPostForMePublisher({
      secretStore: new EncryptedSecretStore(
        new PrismaSecretRecordRepository(client, workspaceId),
        secretStoreMasterKey,
      ),
    });
  const reconcilePublication = createReconcilePublicationHandler({
    attempts: new PrismaPublicationAttemptRepository(client),
    connections: new PrismaProviderConnectionRepository(client),
    publisher: publisherForWorkspace,
  });
  /** One Kokoro client and stage cache shared by the reel and long-form handlers. */
  const speechFor = (ttsUrl: string) =>
    buildSpeechSynthesizer({ ttsUrl, assetStore, assetRepository, env: process.env });
  const renderReel = assetStore
    ? createRenderReelHandler({
        content: new PrismaContentRepository(client),
        channels: new PrismaChannelRepository(client),
        renders: new PrismaReelRenderRepository(client),
        // Voiced Reels get a narration check on a home speech_recognition machine, if any.
        jobs: new PostgresJobQueue(client),
        assets: assetStore,
        assetRepository: new PrismaAssetRepository(client),
        renderer: createFfmpegReelRenderer({
          ...threads,
          // Opt-in reel engine v2 (docs/content-generation/roadmap.md T4); unset keeps v1.
          ...(process.env.REEL_EDIT_STYLE === "v2" ? { editStyle: "v2" as const } : {}),
        }),
        // Opt-in 2.5D slides (docs/creative-engine/v3-plan.md, backlog 1); unset keeps still slides.
        ...(process.env.REEL_PARALLAX === "on" ? { parallax: renderParallaxSlide } : {}),
        autoReels: {
          content: new PrismaContentRepository(client),
          channels: new PrismaChannelRepository(client),
        },
        ...(process.env.REEL_MUSIC_DIR
          ? {
              music: {
                library: createFolderMusicLibrary(process.env.REEL_MUSIC_DIR),
                contentItems: new PrismaContentRepository(client),
                niches: new PrismaNicheRepository(client),
              },
            }
          : {}),
        ...(process.env.TTS_URL
          ? {
              speech: {
                synthesizer: speechFor(process.env.TTS_URL),
                defaultVoiceId: process.env.REEL_VOICE_DEFAULT ?? "pf_dora",
                contentItems: new PrismaContentRepository(client),
                niches: new PrismaNicheRepository(client),
              },
            }
          : {}),
      })
    : undefined;
  const renderLongForm =
    assetStore && process.env.TTS_URL
      ? createRenderLongFormHandler({
          storyboards: new PrismaStoryboardRepository(client),
          scripts: new PrismaEditorialRepository(client),
          renders: new PrismaLongFormRenderRepository(client),
          assets: assetRepository,
          store: assetStore,
          speech: speechFor(process.env.TTS_URL),
          content: contentRepository,
          niches: nicheRepository,
          clipState: new PrismaStoryboardRepository(client),
          staticClip: renderStaticZoomClip,
          rasterizer: rasterizeSvg,
          motionRenderer: createStickmanMotionRenderer({
            timeoutMs: 540_000,
            ...threads,
            ...(limits.layerCache ? { layerCache: true } : {}),
          }),
          ...(process.env.MONEY_MAKER_RELEASE && process.env.MONEY_MAKER_RELEASE !== "dev"
            ? { codeVersion: process.env.MONEY_MAKER_RELEASE }
            : {}),
          chunkStore: createStageCache({
            assets: assetRepository,
            store: assetStore,
            fetchBytes: async (url) =>
              (
                await fetchSafeMedia(new URL(url), {
                  maxBytes: 250_000_000,
                  allowedMimeTypes: ["video/mp4"],
                })
              ).bytes,
            log: (event) => console.info("stage_cache", event),
          }),
          visualQa: createVisualQa(),
          loopFrames: extractLoopFrames,
          costs: new PrismaCostRepository(client),
          ...(process.env.REEL_MUSIC_DIR
            ? { music: createFolderMusicLibrary(process.env.REEL_MUSIC_DIR) }
            : {}),
          renderer: createFfmpegReelRenderer({
            maxSlides: 40,
            maxDurationSec: 900,
            maxOutputBytes: 250_000_000,
            timeoutMs: 540_000,
            ...threads,
          }),
        })
      : undefined;
  // Generative scene clips (spec 2026-09-30): the key comes from the environment, is handed only
  // to the adapter and is never logged. Clips are stored through their own stage cache.
  const agnesApiKey = agnesApiKeyFor(process.env);
  const agnesModel = resolveAgnesModel(process.env.AGNES_MODEL);
  // Local Wan clips replace the hosted provider: no Agnes call is ever made when they are on.
  const localClips = localVideoFor(process.env);
  const generationSettings = new PrismaGenerationSettingsRepository(client);
  const generationRoutes = new PrismaGenerationRouteRepository(client);
  const cloudConnections = new PrismaProviderConnectionRepository(client);
  const secretsFor = (workspaceId: import("@money-maker/contracts").WorkspaceId) =>
    new EncryptedSecretStore(
      new PrismaSecretRecordRepository(client, workspaceId),
      secretStoreMasterKey,
    );
  const modalCallsByToken = new Map<string, ReturnType<typeof createModalCalls>>();
  // Modal clips (spec 2026-10-14): resolved per job from the workspace's connection (env as
  // fallback); free credit first, then the paid month. The SDK client is kept per token.
  const modalClipsFor = async (workspaceId: import("@money-maker/contracts").WorkspaceId) => {
    if (localClips || !r2Signing) return undefined;
    const setup = await modalSetupFor(
      {
        connections: cloudConnections,
        secrets: secretsFor,
        settings: generationSettings,
        env: process.env,
        now: () => new Date(),
      },
      workspaceId,
    );
    if (!setup) return undefined;
    let calls = modalCallsByToken.get(setup.credentials.tokenId);
    if (!calls) {
      calls = createModalCalls({
        token: { id: setup.credentials.tokenId, secret: setup.credentials.tokenSecret },
        app: MODAL_PILOT.app,
        functionName: MODAL_PILOT.functionName,
      });
      modalCallsByToken.set(setup.credentials.tokenId, calls);
    }
    return createModalSceneClipGenerator({
      calls,
      store: createR2ClipObjectStore(r2Signing),
      ledger: new PrismaGenerationBudgetLedger(client),
      policies: setup.policies,
      shape: MODAL_PILOT.shape,
      model: MODAL_PILOT.model,
      fx: () => fetchPtaxUsdBrl(new Date()),
    });
  };
  // Registered whenever a clip source can exist (Modal connections are only known per job); a
  // workspace with none fails its job `scene_clips_unavailable`, as before.
  const clipBase: Omit<GenerateSceneClipsDependencies, "generator" | "model"> | undefined =
    assetStore && (agnesApiKey || localClips || r2Signing)
      ? {
          storyboards: new PrismaStoryboardRepository(client),
          scripts: new PrismaEditorialRepository(client),
          renders: new PrismaLongFormRenderRepository(client),
          clipState: new PrismaStoryboardRepository(client),
          content: contentRepository,
          offers: offerRepository,
          assets: assetRepository,
          store: assetStore,
          ...(localClips ? { localClips } : {}),
          cache: createStageCache({
            assets: assetRepository,
            store: assetStore,
            fetchBytes: async (url) =>
              (
                await fetchSafeMedia(new URL(url), {
                  maxBytes: 50_000_000,
                  allowedMimeTypes: ["video/mp4"],
                })
              ).bytes,
            log: (event) => console.info("stage_cache", event),
          }),
          fetchClip: async (url) =>
            (
              await fetchSafeMedia(new URL(url), {
                maxBytes: 50_000_000,
                allowedMimeTypes: ["video/mp4"],
              })
            ).bytes,
          checkClip: (bytes, expected) => checkSceneClip(bytes, expected),
          jobs: new PostgresJobQueue(client),
          log: (event) => console.info("scene_clips", event),
        }
      : undefined;
  const generateSceneClips = clipBase
    ? async (job: Parameters<ReturnType<typeof createGenerateSceneClipsHandler>>[0]) => {
        const modal = await modalClipsFor(job.payload.workspaceId);
        // No source for this workspace yet (Modal not connected): wait instead of failing, so
        // connecting Modal later picks the job up.
        if (!modal && !localClips && !agnesApiKey)
          throw new RetryLaterJobError(
            "scene_clips_source_missing",
            new Date(Date.now() + 60 * 60 * 1000),
          );
        // Shadow router (spec 2026-10-14): log its pick next to the route that really runs, and
        // record each scene outcome on that route. Neither can fail the job.
        const workspaceId = job.payload.workspaceId;
        const actual = modal
          ? routeId("video.i2v", MODAL_PILOT.model.id, "modal")
          : agnesApiKey && !localClips
            ? routeId("video.i2v", agnesModel, "agnes")
            : null;
        if (actual)
          console.info("generation_route_shadow", {
            task: "video.i2v",
            ...(await shadowChoice(generationRoutes, {
              workspaceId,
              task: "video.i2v",
              actual,
              now: new Date(),
            })),
          });
        const onRun = actual
          ? async (code: string) => {
              const now = new Date();
              await generationRoutes
                .recordRun({
                  workspaceId,
                  routeId: actual,
                  task: "video.i2v",
                  ...clipRunOutcome(code, now),
                  at: now,
                  durationMs: null,
                  detail: code === "ok" ? null : code,
                })
                .catch((error: unknown) =>
                  console.warn("generation_run_record_failed", {
                    error: error instanceof Error ? error.message : "unknown",
                  }),
                );
            }
          : undefined;
        return createGenerateSceneClipsHandler({
          ...clipBase,
          ...(onRun ? { onRun } : {}),
          ...(modal
            ? { generator: modal, staticFallback: true, model: MODAL_PILOT.cacheVersion }
            : agnesApiKey && !localClips
              ? {
                  generator: createAgnesSceneClipGenerator({
                    apiKey: agnesApiKey,
                    model: agnesModel,
                  }),
                  model: agnesModel,
                }
              : { model: agnesModel }),
        })(job);
      }
    : undefined;
  const renderOwnedClip = assetStore
    ? createRenderOwnedClipHandler({
        renders: new PrismaLongFormRenderRepository(client),
        storyboards: new PrismaStoryboardRepository(client),
        scripts: new PrismaEditorialRepository(client),
        assets: assetRepository,
        store: assetStore,
        renderer: createFfmpegOwnedClipRenderer(),
        content: contentRepository,
        niches: nicheRepository,
      })
    : undefined;
  // Experimental AI segmentation (spec 8.3): off unless SEGMENTER_CMD names a local CLI.
  const segmenterCommand = process.env.SEGMENTER_CMD?.trim();
  const segment = segmenterCommand
    ? {
        segmenter: createCommandImageSegmenter({ command: segmenterCommand, timeoutMs: 120_000 }),
        applyMask,
        minConfidence: PROVISIONAL_SEGMENT_MIN_CONFIDENCE,
      }
    : undefined;
  const renderCreatives = assetStore
    ? createRenderCreativesHandler(
        {
          content: contentRepository,
          offers: offerRepository,
          niches: nicheRepository,
          workspaces: new PrismaWorkspaceRepository(client),
          channels: channelRepository,
          assets: assetRepository,
          store: assetStore,
          fetchBytes: async (url) =>
            (
              await fetchSafeMedia(new URL(url), {
                maxBytes: 15_000_000,
                allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
              })
            ).bytes,
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
                ...(segment ? { segment } : {}),
              },
              input,
            ),
          scenes: (input) =>
            pickScene(
              {
                assets: assetRepository,
                store: assetStore,
                generator: sceneGenerator,
                usage: new PrismaUsageRepository(client),
                budget: decideSceneBudget,
                now: () => new Date(),
                onFallback: (reason) =>
                  console.warn("fallback_used", {
                    workspaceId: input.workspaceId,
                    nicheId: input.nicheId,
                    reason,
                  }),
              },
              input,
            ),
          renderer: createSharpCreativeRenderer(),
          fidelity: {
            measurer: createSharpFidelityMeasurer(),
            thresholds: PROVISIONAL_FIDELITY_THRESHOLDS,
          },
          quality: { measureContrast },
          now: () => new Date(),
        },
        (input) =>
          requestAutoReels(
            {
              content: contentRepository,
              channels: channelRepository,
              offers: offerRepository,
              renders: new PrismaReelRenderRepository(client),
              jobs: new PostgresJobQueue(client),
              newId: () => crypto.randomUUID(),
            },
            input,
          ),
      )
    : undefined;
  const researchPolicyRepository = new PrismaResearchPolicyRepository(client);
  const productCandidateRepository = new PrismaProductCandidateRepository(client);
  const researchLoop = createPollingLoop({
    run: () =>
      runDueResearchPolicies({
        policies: researchPolicyRepository,
        niches: nicheRepository,
        candidates: productCandidateRepository,
        marketplaceCatalogForWorkspace,
      }),
    // ponytail: fixed 15-minute poll shared by daily/weekly policies; move to a real
    // scheduler if per-policy cadence ever needs finer control.
    intervalMs: 15 * 60 * 1000,
    onError: (error) => console.error("research sweep failed", error),
  });
  const autonomy = autonomyLoops({
    enabled: process.env.AUTONOMY_ENABLED !== "false",
    profile: selection.profile,
    createLoop: createPollingLoop,
    deps: buildAutonomyDeps(client, marketplaceCatalogForWorkspace).cycle,
  });
  const metricsLoop = createPollingLoop({
    run: () =>
      runDueMetricSyncs({
        performance: new PrismaPerformanceRepository(client),
        connections: new PrismaProviderConnectionRepository(client),
        publisherForWorkspace,
        onError: (error) => console.error("metric sync failed for one post", error),
      }),
    // ponytail: hourly sweep; checkpoints are days apart, so an hour late costs nothing.
    intervalMs: 60 * 60 * 1000,
    onError: (error) => console.error("metric sweep failed", error),
  });
  const offerRefreshLoop = createPollingLoop({
    run: () =>
      refreshActiveOffers({
        offers: new PrismaOfferRepository(client),
        audit: createPrismaAuditPort(client),
        marketplaceCatalogForWorkspace,
        // ponytail: fixed 250ms pause; make it configurable if the ML rate limit needs tuning.
        delayMs: 250,
        onSkipped: (input) => console.error("offer refresh skipped", input),
      }),
    intervalMs: 6 * 60 * 60 * 1000,
    onError: (error) => console.error("offer refresh sweep failed", error),
  });
  // Cloud worker (spec 2026-10-14, plan C2): local-AI tasks on cloud routes while the desktop is
  // off. It needs the public API (it speaks the home worker protocol) and only ever serves
  // qualified cloud routes; with none qualified it issues no token and claims nothing.
  const cloudWorker = process.env.PUBLIC_API_URL
    ? createCloudWorker({
        workspaces: async () =>
          (await client.workspace.findMany({ select: { id: true } })).map((row) =>
            parseWorkspaceId(row.id),
          ),
        tokens: new PrismaHomeWorkerTokenRepository(client),
        routes: generationRoutes,
        jobStats: new PostgresJobQueue(client),
        connections: cloudConnections,
        secrets: secretsFor,
        workersAi:
          process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
            ? {
                accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
                apiToken: process.env.CLOUDFLARE_API_TOKEN,
              }
            : null,
        apiUrl: new URL(process.env.PUBLIC_API_URL),
        log: (event, detail) => console.info(event, detail),
      })
    : null;
  const cloudWorkerLoop = cloudWorker
    ? createPollingLoop({
        run: async () => void (await cloudWorker.round()),
        intervalMs: 30_000,
        onError: (error) => console.error("cloud worker round failed", error),
      })
    : null;
  const sceneDirectorConfig = readSceneDirectorConfig(process.env);
  const frameReviewerConfig = readFrameReviewerConfig(process.env);
  const registered: Record<string, JobHandler> = {
    publish_content: async (job) => {
      const result = await publishContent(job);
      if (result.action === "retryable_failure") {
        if (result.reason === "evidence_unverifiable") {
          throw new RetryLaterJobError(result.reason, new Date(Date.now() + 15 * 60 * 1000));
        }
        throw new Error(result.reason);
      }
      if (result.action === "permanent_failure" || result.action === "unknown_outcome") {
        // Carry the real reason (e.g. provider_credential_expired) into the job record and
        // needs-attention view instead of the generic default.
        throw new PermanentJobError(result.reason);
      }
    },
    reconcile_publication: async (job) => {
      await reconcilePublication(job);
    },
    produce_offer_package: createProduceOfferPackageHandler({
      offers: offerRepository,
      audit: createPrismaAuditPort(client),
      content: contentRepository,
      candidates: productCandidateRepository,
      assets: assetRepository,
      jobs: new PostgresJobQueue(client),
      catalogForWorkspace: marketplaceCatalogForWorkspace,
      now: () => new Date(),
    }),
    ...(renderReel ? { render_reel: async (job, context) => renderReel(job, context) } : {}),
    ...(renderLongForm
      ? { render_long_form: async (job, context) => renderLongForm(job, context) }
      : {}),
    ...(generateSceneClips ? { generate_scene_clips: async (job) => generateSceneClips(job) } : {}),
    ...(renderOwnedClip
      ? { render_owned_clip: async (job, context) => renderOwnedClip(job, context) }
      : {}),
    // Local scene director (v2 slice 26): off unless SCENE_DIRECTOR_URL is set, and only a
    // local_ai worker with a verified scene_director model can claim it (selectHandlers).
    ...(sceneDirectorConfig
      ? {
          direct_scenes: createDirectScenesHandler({
            scripts: new PrismaEditorialRepository(client),
            content: contentRepository,
            niches: nicheRepository,
            storyboards: new PrismaStoryboardRepository(client),
            director: createLlamaServerSceneDirector(sceneDirectorConfig),
          }),
        }
      : {}),
    // Local plate generation (v2 slice 27): only with a local SCENE_GENERATOR_CMD (never Workers
    // AI) and an asset store; a local_ai worker also needs a verified image_generation model.
    ...(assetStore && process.env.SCENE_GENERATOR_CMD && sceneGenerator
      ? {
          generate_plates: createGeneratePlatesHandler({
            niches: nicheRepository,
            bank: {
              assets: assetRepository,
              store: assetStore,
              generator: sceneGenerator,
              usage: new PrismaUsageRepository(client),
              budget: () => "generate",
              now: () => new Date(),
              postProcess: postProcessPlate,
            },
          }),
        }
      : {}),
    // VLM key-frame review (v2 slice 29): off unless FRAME_REVIEWER_URL is set; a local_ai worker
    // also needs a verified visual_qa model. The video is fetched through a signed store URL.
    ...(assetStore && frameReviewerConfig
      ? {
          review_frames: createReviewFramesHandler({
            renders: new PrismaLongFormRenderRepository(client),
            assets: assetRepository,
            store: assetStore,
            fetchVideo: async (url) =>
              (
                await fetchSafeMedia(new URL(url), {
                  maxBytes: 250_000_000,
                  allowedMimeTypes: ["video/mp4"],
                })
              ).bytes,
            extractFrames: (video, times) => extractKeyFrames(video, times),
            reviewer: createLlamaServerFrameReviewer(frameReviewerConfig),
            model: frameReviewerConfig.model,
          }),
        }
      : {}),
    ...(renderCreatives ? { render_creatives: async (job) => renderCreatives(job) } : {}),
  };
  const handlers = selectHandlers({ handlers: registered, ...selection });
  assertLeaseFitsReelReset({
    jobs: Object.keys(handlers),
    leaseDurationMs: limits.leaseDurationMs,
  });
  const workerId = process.env.WORKER_ID ?? crypto.randomUUID();
  console.info("worker_ready", {
    workerId,
    generationPolicy: parseGenerationPolicy(process.env.GENERATION_POLICY),
    profile: selection.profile,
    jobs: Object.keys(handlers),
    capabilities: selection.capabilities,
    leaseDurationMs: limits.leaseDurationMs,
  });
  return {
    worker: createWorker({
      queue: new PostgresJobQueue(client),
      handlers,
      workerId,
      // Serial per process; the queue lets one heavy render run at a time across processes, and
      // heavyJobTimeoutMs + 60 s always fits inside the lease (readRenderLimits enforces it).
      leaseDurationMs: limits.leaseDurationMs,
      heavyJobTimeoutMs: limits.heavyJobTimeoutMs,
      ...(limits.longFormJobTimeoutMs !== undefined
        ? { longFormJobTimeoutMs: limits.longFormJobTimeoutMs }
        : {}),
      ...(limits.localAiJobTimeoutMs !== undefined
        ? { localAiJobTimeoutMs: limits.localAiJobTimeoutMs }
        : {}),
      pollIntervalMs: 1_000,
      onClaimLost: (job) =>
        console.warn("job_claim_lost", { workerId, jobId: job.id, name: job.name }),
    }),
    // The sweeps are in-process loops with no lease: only the full worker runs them, so adding
    // a render_only worker never duplicates them.
    loops:
      selection.profile === "full"
        ? [
            researchLoop,
            metricsLoop,
            offerRefreshLoop,
            ...autonomy,
            ...(cloudWorkerLoop ? [cloudWorkerLoop] : []),
          ]
        : [],
    close: () => client.$disconnect(),
  };
};

export const startWorker = async (): Promise<WorkerDependencies> => {
  try {
    const environment = parseWorkerEnvironment(process.env);
    const secretStoreMasterKey = process.env.SECRET_STORE_MASTER_KEY;
    if (!secretStoreMasterKey) {
      throw new Error(
        "Invalid environment configuration. Set SECRET_STORE_MASTER_KEY for the worker.",
      );
    }
    const masterKey = Buffer.from(secretStoreMasterKey, "base64url");
    if (masterKey.length !== 32) {
      throw new Error(
        "Invalid environment configuration. SECRET_STORE_MASTER_KEY must be 32 bytes base64url.",
      );
    }
    await assertRendererReady({
      assertFontsPresent,
      renderSelfCheck: renderCreativeRendererSelfCheck,
      verifyOutput: verifyCreativeRendererOutput,
    });
    const r2Signing =
      environment.R2_ACCOUNT_ID &&
      environment.R2_ACCESS_KEY_ID &&
      environment.R2_SECRET_ACCESS_KEY &&
      environment.R2_BUCKET
        ? createR2S3SigningClient({
            accountId: environment.R2_ACCOUNT_ID,
            accessKeyId: environment.R2_ACCESS_KEY_ID,
            secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
            bucketName: environment.R2_BUCKET,
          })
        : undefined;
    const assetStore =
      r2Signing && environment.R2_BUCKET
        ? new R2AssetStore(r2Signing, environment.R2_BUCKET, environment.R2_SIGNED_URL_TTL ?? 900)
        : undefined;
    const sceneGenerator = sceneGeneratorFor(environment);
    const localAi = environment.WORKER_PROFILE === "local_ai";
    // Decision D4 is open: a local_ai worker never touches a remote database (worker-profile.ts).
    if (localAi) assertLocalAiDatabase(environment.DATABASE_URL);
    const renderLimits = readRenderLimits(process.env);
    const limits: RenderLimits = localAi
      ? { ...renderLimits, ...readLocalAiLimits(process.env) }
      : renderLimits;
    try {
      // Background renders yield the CPU to the API on a shared host; children inherit it.
      setPriority(limits.nice);
    } catch {
      // Lowering priority is best-effort (some sandboxes forbid it).
    }
    if (limits.threads !== undefined) limitImageThreads(limits.threads);
    await sweepRenderTemp({ root: tmpdir(), olderThanMs: limits.leaseDurationMs });
    const detected = await detectCapabilities({
      ttsUrl: process.env.TTS_URL,
      agnesApiKey: agnesApiKeyFor(process.env),
    });
    const verification = localAi
      ? await verifyModels(environment.LOCAL_MODELS_DIR as string, environment.WORKER_MACHINE_KIND)
      : undefined;
    if (verification)
      console.info("models_verified", {
        verified: verification.verified,
        failures: verification.failures,
      });
    // Modal can be connected at any time from MCP, so presigned R2 is enough to claim clip jobs
    // (a job with no source waits, see generateSceneClips). A configured Agnes key whose probe
    // failed keeps clips off, as before: that worker would only fail them.
    const agnesProbeFailed = Boolean(agnesApiKeyFor(process.env)) && !detected.scene_clips;
    const withModal =
      r2Signing &&
      !agnesProbeFailed &&
      cloudGenerationAllowed(parseGenerationPolicy(process.env.GENERATION_POLICY))
        ? { ...detected, scene_clips: true }
        : detected;
    const capabilities = verification
      ? { ...withModal, verified: verification.verified }
      : withModal;
    return createWorkerDependencies(
      environment.DATABASE_URL,
      masterKey,
      assetStore,
      sceneGenerator,
      limits,
      { profile: environment.WORKER_PROFILE, jobs: environment.WORKER_JOBS, capabilities },
      r2Signing,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("font_missing:") ||
        error.message.startsWith("worker_") ||
        error.message.startsWith("local_ai_") ||
        error.message === "renderer_self_check_failed" ||
        error.message.startsWith("render_"))
    )
      throw error;
    throw new Error("Invalid environment configuration. Check DATABASE_URL and worker secrets.");
  }
};

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  void (async () => {
    let dependencies: WorkerDependencies;
    try {
      dependencies = await startWorker();
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : "Worker startup failed.");
      process.exitCode = 1;
      return;
    }
    const runtime = dependencies;
    const shutdown = () => {
      runtime.worker.requestStop();
      for (const loop of runtime.loops) loop.requestStop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    Promise.all([runtime.worker.run(), ...runtime.loops.map((loop) => loop.run())])
      .then(() => runtime.close())
      .catch(async () => {
        console.error("Worker stopped unexpectedly.");
        process.exitCode = 1;
        await runtime.close();
      });
  })();
}
