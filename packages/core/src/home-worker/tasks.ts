import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { COMMERCIAL_USE_BY_PROVIDER, LOCAL_GENERATOR_LICENSES } from "../assets/asset.js";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import {
  clipSeconds,
  type LocalClipProfile,
  localClipProfile,
} from "../assets/local-clip-profile.js";
import { modelPolicyFor } from "../assets/model-policy.js";
import { SCENE_CLIP_STAGE } from "../assets/scene-clip-generator.js";
import type { StageCache } from "../assets/stage-cache.js";
import type { AuditPort } from "../audit/audit-port.js";
import type { ChannelRepository } from "../channels/channel-repository.js";
import { compileClipPrompt } from "../content/clip-prompt.js";
import { snapshotStillBacksContent } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { checkDirectorOutput } from "../content/direct-scenes.js";
import { directionInputFor } from "../content/direction-input.js";
import type { EditorialRepository } from "../content/editorial-repository.js";
import {
  checkLongFormOutput,
  pacingBlocked,
  pacingReport,
} from "../content/long-form-direction.js";
import {
  buildOfferCopyInput,
  checkOfferCopyDraft,
  OFFER_COPY_CHANNELS,
  type OfferCopyChannel,
  type OfferCopyDraft,
  type OfferCopyHookCandidate,
  type OfferCopyInput,
  offerCopyHookCandidates,
} from "../content/offer-copy.js";
import { isAutoSaleItem } from "../content/offer-package.js";
import type { SceneClipState, SceneClipStateRepository } from "../content/scene-clip-state.js";
import { createStoryboard, isClipStoryboard, isOwnedClipReference } from "../content/storyboard.js";
import type { StoryboardRepository } from "../content/storyboard-repository.js";
import {
  type BuildPostCreativesDeps,
  buildPostCreatives,
} from "../creatives/build-post-creatives.js";
import {
  activeCount,
  fillSceneBank,
  type PlatePostProcessor,
  plateRequestsFor,
} from "../creatives/fill-scene-bank.js";
import {
  isCountCritical,
  productVisualSpecFor,
  standsOnFloor,
} from "../creatives/in-scene-fidelity.js";
import type { SceneBankDeps, SceneGenerator } from "../creatives/scene-bank.js";
import { type ArtDirectionInput, validateSceneLines } from "../creatives/scene-direction.js";
import type { SlideSpec } from "../creatives/slide-spec.js";
import { pickStrongestHook } from "../decisions/hook-pick.js";
import type { DecisionProvider } from "../decisions/jev-shadow.js";
import type { SceneDirectorInput } from "../explainer/scene-director.js";
import {
  keyFramePlan,
  VLM_ISSUE_KINDS,
  type VlmReviewResult,
  withVlmReview,
} from "../explainer/visual-qa/vlm-review.js";
import { executorOfToken, recordHomeRun } from "../generation/home-routes.js";
import type { GenerationRouteRepository } from "../generation/route-repository.js";
import {
  type ClaimedJob,
  createGenerateOfferScenesJob,
  createRenderCreativesJob,
  type EnqueueJobInput,
  type JobQueue,
  parseVersionedIdentifierPayload,
} from "../jobs/job.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import type { MarketplaceCatalog } from "../offers/marketplace-catalog.js";
import { type CommercialFact, productIdFromOffer } from "../offers/offer.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import {
  createGenerateClipsJob,
  createRenderLongFormJob,
  type LongFormRenderRepository,
} from "../publishing/long-form-render.js";
import {
  applyOfferScenes,
  applySceneFidelity,
  buildOfferScenesTask,
  buildSceneFidelityTask,
  type OfferSceneDeps,
  type OfferSceneResult,
  type OfferSceneTask,
  type SceneFidelityResult,
  type SceneFidelityTask,
} from "./offer-scene-task.js";
import { RetryableTaskError, TaskError } from "./task-error.js";

export { MAX_SCENE_BYTES, OFFER_SCENES_PER_TASK } from "./offer-scene-task.js";

import {
  applyNarration,
  buildNarrationTask,
  type NarrationDeps,
  type NarrationResult,
  type NarrationTask,
} from "./narration-task.js";
import { CAPABILITY_JOBS, type HomeCapability, type HomeWorkerToken } from "./tokens.js";

/**
 * The home worker task protocol (ADR 0012). The server claims a local-AI job for one token's
 * workspace, turns it into a self-contained task, and later applies the posted result after
 * validating it exactly as the in-process handlers do. The home machine never sees the database.
 */
export type HomeTask =
  | Readonly<{
      kind: "direct_scenes";
      jobId: string;
      leaseToken: string;
      input: SceneDirectorInput;
      /** Long-form niche: the machine directs the script chapter by chapter and posts one plan each. */
      longForm?: true;
    }>
  | Readonly<{
      kind: "generate_plates";
      jobId: string;
      leaseToken: string;
      requests: readonly Readonly<{
        key: string;
        prompt: string;
        size?: Readonly<{ width: number; height: number }> | undefined;
      }>[];
    }>
  | Readonly<{
      kind: "review_frames";
      jobId: string;
      leaseToken: string;
      videoUrl: string;
      frames: readonly Readonly<{ sceneIndex: number; hook: boolean; timeMs: number }>[];
    }>
  | Readonly<{
      kind: "draft_offer_copy";
      jobId: string;
      leaseToken: string;
      /** Closed packet: verified facts, bounded untrusted buyer excerpts, niche voice. */
      input: OfferCopyInput;
      /** What the home side needs to repair, validate and correct the draft like the server. */
      validation: Readonly<{
        sourceFactKeys: readonly string[];
        captionMaxLength: Readonly<Partial<Record<OfferCopyChannel, number>>>;
      }>;
      /**
       * Cast and world for one scene line per slide (scene-direction.ts), written by the same
       * model after the copy. Absent when the niche has no main character.
       */
      artDirection?: ArtDirectionContext;
    }>
  | Readonly<{
      kind: "generate_clips";
      jobId: string;
      leaseToken: string;
      /** One scene per task; the server picks the next scene without a clip. */
      sceneIndex: number;
      prompt: string;
      negativePrompt: string;
      /** Short-lived signed download of the approved owned plate or character sheet only. */
      referenceUrl: string;
      profile: LocalClipProfile;
    }>
  | OfferSceneTask
  | SceneFidelityTask
  | NarrationTask;

export type HomeResult =
  | Readonly<{
      kind: "generate_clips";
      sceneIndex: number;
      bytes: Uint8Array;
      mimeType: "video/mp4" | "video/webm";
      model: string;
      provenance?: Readonly<{ runtime: string; observedModel?: string; runtimeVersion?: string }>;
    }>
  | Readonly<{ kind: "direct_scenes"; scenes: unknown }>
  | Readonly<{
      kind: "generate_plates";
      plates: readonly Readonly<{
        key: string;
        bytes: Uint8Array;
        model: string;
        seed?: number;
        provenance?: Readonly<{ runtime: string; observedModel?: string; runtimeVersion?: string }>;
      }>[];
    }>
  | Readonly<{ kind: "review_frames"; review: VlmReviewResult }>
  | Readonly<{
      kind: "draft_offer_copy";
      draft: OfferCopyDraft;
      /** Raw art-director JSON for the draft's slides; validated here, never trusted as is. */
      sceneLines?: unknown;
      /** The model the machine says it ran; must be a server-policy LLM entry. */
      model: string;
      provenance?: Readonly<{ runtime: string; observedModel?: string }>;
    }>
  | OfferSceneResult
  | SceneFidelityResult
  | NarrationResult;

export type HomeTaskDeps = Readonly<{
  queue: Pick<JobQueue, "claim" | "complete" | "retry" | "failPermanently"> &
    Required<Pick<JobQueue, "takeLease">>;
  leaseDurationMs: number;
  scripts: Pick<EditorialRepository, "findScriptForWorkspace">;
  content: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
  storyboards: Pick<StoryboardRepository, "findLatestForScript" | "create">;
  renders: Pick<LongFormRenderRepository, "findForWorkspace"> &
    Required<Pick<LongFormRenderRepository, "recordVisualReview">>;
  assets: Pick<AssetRepository, "findForWorkspace">;
  store: Pick<AssetStore, "createDownload">;
  bank: Omit<SceneBankDeps, "generator">;
  postProcess?: PlatePostProcessor | undefined;
  /**
   * Fully decodes a posted image and re-encodes it (sharp in providers), so only clean pixels
   * are stored: no trailing data, no truncated file, no decompression bomb.
   */
  reencodeImage: (
    bytes: Uint8Array,
  ) => Promise<Readonly<{ bytes: Uint8Array; mimeType: string; width: number; height: number }>>;
  /** Run log of the generation routes (spec 2026-10-14); absent records nothing. */
  routes?: Pick<GenerationRouteRepository, "recordRun"> | undefined;
  /** Present only where the copywriting capability is served (needs the build-creatives deps). */
  offerCopy?: Readonly<{
    offers: Pick<OfferRepository, "findForWorkspace">;
    channels: Required<Pick<ChannelRepository, "listForWorkspace">>;
    catalogForWorkspace: (workspaceId: WorkspaceId) => MarketplaceCatalog | undefined;
    build: BuildPostCreativesDeps;
  }>;
  /** Present only where the video_generation capability is served (local Wan clips). */
  clips?: Readonly<{
    /** LOCAL_VIDEO_ENABLED; with the policy check below it is the only way a clip task exists. */
    enabled: boolean;
    /** The configured VIDEO_GEN_MODEL, checked against model policy at claim time. */
    model: string;
    maxBytes: number;
    maxFrames: number;
    storyboards: Pick<StoryboardRepository, "findForWorkspace">;
    offers: Pick<OfferRepository, "findForWorkspace">;
    clipState: SceneClipStateRepository;
    cache: StageCache;
    jobs: Pick<JobQueue, "enqueue">;
    /** ffprobe of the posted bytes (providers); counts decoded frames. */
    probeVideo: (bytes: Uint8Array, mimeType: string) => Promise<ClipProbe>;
    /** Re-encodes posted WebM/MP4 into the h264 MP4 the renderer reads. */
    toMp4: (bytes: Uint8Array, mimeType: string) => Promise<Uint8Array>;
  }>;
  /** Present where auto packages get in-scene art (image_editing + visual_qa, plan D1/D2). */
  offerScenes?: OfferSceneDeps;
  /** Present where the speech_recognition capability is served (Reel narration check). */
  narration?: NarrationDeps;
  /** Jev (JEV_ENABLED with a key): advisory pick of the strongest validated copy hook. */
  decisions?: Readonly<{ provider: DecisionProvider; audit: Pick<AuditPort, "record"> }>;
  now: () => Date;
}>;

export type ClipProbe = Readonly<{
  readable: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  decodeErrors: number;
}>;

/**
 * The copy is built only when the slides are stored AND their variants exist: a crash between
 * the two writes leaves slides without variants, and the next result must rebuild them. Built
 * means a variant for every selected channel; then the (idempotent) render job is enqueued again
 * in case a crash happened before it.
 */
const offerCopyBuilt = async (
  build: BuildPostCreativesDeps,
  workspaceId: WorkspaceId,
  item: Readonly<{ id: string; creativeSlides?: readonly unknown[] | undefined }>,
  channelIds: readonly string[],
  nextJob: EnqueueJobInput,
): Promise<boolean> => {
  if (!item.creativeSlides?.length) return false;
  // ponytail: scans the workspace's variants; add a per-item lookup if workspaces grow large.
  const variants = await build.contentRepository.listVariantsForWorkspace(workspaceId);
  const built = channelIds.every((channelId) =>
    variants.some(
      (variant) => variant.contentItemId === item.id && variant.channelId === channelId,
    ),
  );
  if (built) await build.jobQueue.enqueue(nextJob);
  return built;
};
/** Auto packages draw in-scene art first (D1) where it is served; the rest render at once. */
const jobAfterCopy = (
  deps: HomeTaskDeps,
  workspaceId: WorkspaceId,
  item: Readonly<{ id: string; offerId: string | null }>,
): EnqueueJobInput =>
  deps.offerScenes && isAutoSaleItem(item)
    ? createGenerateOfferScenesJob({ workspaceId, contentItemId: item.id, round: "start" })
    : createRenderCreativesJob({ workspaceId, contentItemId: item.id, attempt: 1 });
const channelIdsOf = (channels: ReadonlyMap<unknown, { id: string }>) =>
  [...channels.values()].map((channel) => channel.id);

export const MAX_PLATE_BYTES = 10_000_000;
// ponytail: a fixed cap keeps result bodies bounded (plates travel inline); the rest of a niche's
// plates wait for the next day's generate_plates job. Upload URLs if niches outgrow this.
export const PLATES_PER_TASK = 3;
const MIN_PLATE_PX = 512;
export const MAX_PLATE_PX = 4096;
const VLM_FINDING_IDS: ReadonlySet<string> = new Set(VLM_ISSUE_KINDS.map((kind) => `vlm_${kind}`));
const MAX_VLM_NOTE = 140;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ direction

const prepareDirection = async (deps: HomeTaskDeps, workspaceId: WorkspaceId, scriptId: string) => {
  const script = await deps.scripts.findScriptForWorkspace({ workspaceId, scriptId });
  if (script?.status !== "approved") throw new TaskError("script_not_approved");
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: script.contentItemId,
  });
  const niche = item
    ? await deps.niches.findForWorkspace({ workspaceId, nicheId: item.nicheId })
    : null;
  const prepared = directionInputFor(script, niche);
  if (!prepared.ok) throw new TaskError(prepared.reason);
  return { script, ...prepared };
};

// ------------------------------------------------------------------ plates

const missingPlateRequests = async (
  deps: HomeTaskDeps,
  workspaceId: WorkspaceId,
  nicheId: string,
) => {
  const niche = await deps.niches.findForWorkspace({ workspaceId, nicheId });
  if (niche?.state !== "active") throw new TaskError("niche_unavailable");
  const missing = [];
  for (const request of plateRequestsFor(niche)) {
    const pool = await deps.bank.assets.listByMetadata({
      workspaceId,
      role: request.role,
      key: "sceneKey",
      value: request.key,
    });
    // Images held for review count too, or every claim would ask for the same plates again.
    const held = await deps.bank.assets.listByMetadata({
      workspaceId,
      role: request.role,
      key: "sceneKey",
      value: request.key,
      state: "pending_review",
    });
    if (activeCount(pool, deps.now()) + held.length < request.poolMin) missing.push(request);
  }
  return { niche, missing };
};

// ------------------------------------------------------------------ review

const reviewableRender = async (deps: HomeTaskDeps, workspaceId: WorkspaceId, renderId: string) => {
  const render = await deps.renders.findForWorkspace({ workspaceId, renderId });
  const manifest = render?.timingManifest;
  if (render?.status !== "ready" || !render.assetId || !manifest || !render.qualityReport)
    throw new TaskError("render_not_reviewable");
  if (render.qualityReport.visual?.vlm?.vlm === "reviewed") throw new TaskError("already_reviewed");
  const asset = await deps.assets.findForWorkspace({ workspaceId, assetId: render.assetId });
  if (
    !asset ||
    asset.workspaceId !== workspaceId ||
    asset.state !== "active" ||
    asset.mimeType !== "video/mp4" ||
    asset.checksum !== manifest.renderedAssetChecksum
  )
    throw new TaskError("render_asset_unavailable");
  return { render, manifest, asset, qualityReport: render.qualityReport };
};

// ------------------------------------------------------------------ offer copy

const prepareOfferCopy = async (deps: HomeTaskDeps, workspaceId: WorkspaceId, itemId: string) => {
  const copy = deps.offerCopy;
  if (!copy) throw new Error("offer_copy_unavailable");
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: itemId,
  });
  if (!item?.offerId || !item.offerSnapshotId) throw new TaskError("content_not_found");
  const offer = await copy.offers.findForWorkspace({ workspaceId, offerId: item.offerId });
  if (offer?.state !== "active") throw new TaskError("offer_not_active");
  if (!snapshotStillBacksContent(offer, item.offerSnapshotId, item.sourceFactKeys))
    throw new TaskError("offer_facts_changed");
  const facts = offer.snapshots.find((entry) => entry.id === item.offerSnapshotId)?.facts ?? [];
  const niche = await deps.niches.findForWorkspace({ workspaceId, nicheId: item.nicheId });
  if (niche?.state !== "active") throw new TaskError("niche_unavailable");
  const channels = new Map<OfferCopyChannel, { id: string; captionMaxLength: number }>();
  for (const channel of [...(await copy.channels.listForWorkspace(workspaceId))].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const kind = channel.kind as OfferCopyChannel;
    // Only the item's own niche profile: a channel bound to no niche or another one never
    // receives an automatic post (fail closed with no_active_channels).
    if (
      channel.status === "active" &&
      channel.nicheId === item.nicheId &&
      (OFFER_COPY_CHANNELS as readonly string[]).includes(kind) &&
      !channels.has(kind)
    )
      channels.set(kind, {
        id: channel.id,
        captionMaxLength: channel.capabilities.captionMaxLength,
      });
  }
  if (channels.size === 0) throw new TaskError("no_active_channels");
  return { copy, item, offer, facts, niche, channels };
};

/**
 * Jev chooses among hooks that already passed every deterministic gate, so it never adds text or
 * facts: advisory selection, not routing. That is why it runs under JEV_ENABLED while JEV_MODE
 * stays "shadow" (config still rejects "active" until routing is calibrated). Any Jev error,
 * timeout or low confidence keeps the original; the audit is best effort and never fails the job.
 */
const pickOfferHook = async (
  deps: HomeTaskDeps,
  context: Readonly<{
    workspaceId: WorkspaceId;
    itemId: string;
    offerTitle: string;
    niche: string;
    facts: readonly CommercialFact[];
  }>,
  candidates: readonly OfferCopyHookCandidate[],
): Promise<OfferCopyHookCandidate | undefined> => {
  const decisions = deps.decisions;
  if (!decisions || candidates.length < 2) return candidates[0];
  const hooks = candidates.map((c) => c.filled.slides[0]?.headline ?? "");
  const pick = await pickStrongestHook(decisions.provider, {
    hooks,
    niche: context.niche,
    offerTitle: context.offerTitle,
    verifiedFacts: context.facts
      .filter((fact) => fact.verified)
      .map(({ key, value }) => ({ key, value })),
  });
  try {
    await decisions.audit.record({
      action: "ai.decision.hook_picked",
      workspaceId: context.workspaceId,
      systemActor: "system:jev-hook-pick",
      targetType: "ContentItem",
      targetId: context.itemId,
      metadata: {
        name: "hook_strength",
        status: pick.status,
        chosenIndex: pick.chosenIndex,
        candidatesJson: JSON.stringify(hooks),
        scoresJson: JSON.stringify(pick.scores),
        confidencesJson: JSON.stringify(pick.confidences),
        requestedModel: pick.requestedModel,
        resolvedModel: pick.resolvedModel,
      },
    });
  } catch {
    // Optional decision evidence cannot fail the accepted copy.
  }
  return candidates[pick.chosenIndex] ?? candidates[0];
};

/** Name of the niche's main recurring character (niche context characters), if any. */
const mainCharacterName = (context: Readonly<Record<string, unknown>> | null | undefined) => {
  const cast: unknown[] = Array.isArray(context?.characters) ? context.characters : [];
  for (const entry of cast) {
    if (typeof entry !== "object" || entry === null) continue;
    const { role, name } = entry as { role?: unknown; name?: unknown };
    if (role === "main" && typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
};

export type ArtDirectionContext = Omit<ArtDirectionInput, "slides">;
/** The niche's cast and world for the art director; undefined without a main character. */
export const artDirectionContextOf = (
  context: Readonly<Record<string, unknown>> | null | undefined,
  offerTitle: string,
): ArtDirectionContext | undefined => {
  const cast: unknown[] = Array.isArray(context?.characters) ? context.characters : [];
  const named = cast.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { role, name, description } = entry as Record<string, unknown>;
    return typeof name === "string" && name.trim()
      ? [
          {
            role,
            name: name.trim(),
            description: typeof description === "string" ? description : "",
          },
        ]
      : [];
  });
  const main = named.find((entry) => entry.role === "main");
  if (!main) return undefined;
  const world =
    typeof context?.storyWorld === "string" && context.storyWorld.trim()
      ? context.storyWorld
          .trim()
          .replace(/^Scene:\s*/i, "")
          .replace(/\.$/, "")
      : "the place at home where it is used";
  return {
    product: offerTitle
      .replace(/R\$\s*[\d.,]+/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
    character: { name: main.name, description: main.description.slice(0, 300) },
    otherNames: named.filter((entry) => entry !== main).map((entry) => entry.name),
    // First sentence only: default scene lines embed the world, and a whole story world (500+
    // characters on Beleza) pushed them past the 300-character slide limit (2026-10-15).
    world: (world.split(/(?<=[.!?])\s+/)[0] ?? world)
      .replace(/[.!?]$/, "")
      .slice(0, 160)
      .trim(),
    countCritical: isCountCritical(productVisualSpecFor(offerTitle)),
    onFloor: standsOnFloor(offerTitle),
  };
};

/** Validated scene lines on the slides, when the machine sent any; the slot's default otherwise. */
const withSceneLines = (
  slides: readonly SlideSpec[],
  raw: unknown,
  context: ArtDirectionContext | undefined,
): readonly SlideSpec[] => {
  if (raw === undefined || !context) return slides;
  const lines = validateSceneLines(raw, {
    ...context,
    slides: slides.map((slide) => ({
      index: slide.index,
      template: slide.template,
      headline: slide.headline,
      body: slide.body,
    })),
  });
  return slides.map((slide) => {
    const line = lines.find((entry) => entry.index === slide.index);
    return line ? { ...slide, sceneLine: line.line, sceneLineSource: line.source } : slide;
  });
};

const captionLimitsOf = (
  channels: ReadonlyMap<OfferCopyChannel, Readonly<{ captionMaxLength: number }>>,
): Partial<Record<OfferCopyChannel, number>> =>
  Object.fromEntries([...channels].map(([kind, channel]) => [kind, channel.captionMaxLength]));

// ------------------------------------------------------------------ clips

/** One controlled retry per scene, then the scene falls back to a static plate clip. */
const MAX_CLIP_ATTEMPTS = 2;
const clipDone = (state: SceneClipState | undefined): boolean =>
  state?.status === "ready" || state?.status === "fallback_static";
const clipModelAllowed = (model: string): boolean => {
  const policy = modelPolicyFor(model);
  return (
    policy?.capability === "video_generation" &&
    policy.enabled &&
    policy.licensePolicy === "commercial_allowed"
  );
};

const prepareClips = async (deps: HomeTaskDeps, workspaceId: WorkspaceId, renderId: string) => {
  const clips = deps.clips;
  if (!clips?.enabled) throw new TaskError("local_video_disabled");
  if (!clipModelAllowed(clips.model)) throw new TaskError("video_model_not_enabled");
  const render = await deps.renders.findForWorkspace({ workspaceId, renderId });
  if (render?.status !== "pending") throw new TaskError("render_not_pending");
  const board = await clips.storyboards.findForWorkspace({
    workspaceId,
    storyboardId: render.storyboardId,
  });
  if (!board || !isClipStoryboard(board)) throw new TaskError("storyboard_not_ai_clips");
  const script = await deps.scripts.findScriptForWorkspace({
    workspaceId,
    scriptId: board.scriptId,
  });
  if (script?.status !== "approved" || script.approvedChecksum !== script.checksum)
    throw new TaskError("script_not_approved");
  const states = await clips.clipState.read({ workspaceId, storyboardId: board.id });
  const scene = board.scenes.find((candidate) => !clipDone(states[String(candidate.index)]));
  return { clips, render, board, script, states, scene };
};
type ClipPrep = Awaited<ReturnType<typeof prepareClips>>;

/** Everything a scene's task and its result check share. Refuses unsafe references. */
const planClip = async (
  deps: HomeTaskDeps,
  workspaceId: WorkspaceId,
  prep: ClipPrep,
  scene: NonNullable<ClipPrep["scene"]>,
) => {
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: prep.board.contentItemId,
  });
  const offer = item?.offerId
    ? await prep.clips.offers.findForWorkspace({ workspaceId, offerId: item.offerId })
    : null;
  const compiled = compileClipPrompt({
    clipPrompt: scene.clipPrompt,
    forbiddenTerms: offer ? [offer.title] : [],
    ...(offer ? { offerTitle: offer.title } : {}),
  });
  if (!compiled.ok) throw new TaskError(`clip_prompt_refused:${compiled.reason}`.slice(0, 150));
  if (scene.referenceAssetId === undefined) throw new TaskError("clip_reference_required");
  const reference = await deps.assets.findForWorkspace({
    workspaceId,
    assetId: scene.referenceAssetId,
  });
  // INV-G1: only an owned scene plate or character sheet; never a listing or product photo.
  if (!reference || !isOwnedClipReference(reference, workspaceId))
    throw new TaskError("unsafe_reference");
  const profile = localClipProfile({
    canvas: prep.board.canvas,
    seconds: clipSeconds(
      prep.script.body.slice(scene.fromChar, scene.toChar),
      prep.script.language,
    ),
    maxFrames: prep.clips.maxFrames,
  });
  if (!profile) throw new TaskError("clip_profile_unavailable");
  return { prompt: compiled.prompt, negativePrompt: compiled.negativePrompt, reference, profile };
};

/** Objective checks on a posted clip; null means usable. */
const clipFault = async (
  clips: NonNullable<HomeTaskDeps["clips"]>,
  profile: LocalClipProfile,
  result: Extract<HomeResult, { kind: "generate_clips" }>,
): Promise<{ code: string } | { mp4: Uint8Array }> => {
  const size = result.bytes.byteLength;
  if (size === 0 || size > clips.maxBytes) return { code: "size" };
  const probe = await clips.probeVideo(result.bytes, result.mimeType).catch(() => null);
  if (!probe?.readable || !probe.hasVideo) return { code: "unreadable" };
  if (probe.decodeErrors > 0) return { code: "decode_errors" };
  if (probe.width !== profile.width || probe.height !== profile.height)
    return { code: "dimensions" };
  if (probe.frameCount > profile.frames) return { code: "frames_over_cap" };
  if (probe.frameCount < profile.frames - 2) return { code: "frames_short" };
  if (!(probe.durationMs > 0)) return { code: "duration" };
  const mp4 =
    result.mimeType === "video/mp4"
      ? result.bytes
      : await clips.toMp4(result.bytes, result.mimeType).catch(() => null);
  return mp4 && mp4.byteLength > 0 ? { mp4 } : { code: "transcode" };
};

// ------------------------------------------------------------------ claim

const jobsFor = (token: HomeWorkerToken): readonly string[] =>
  token.capabilities.flatMap((capability: HomeCapability) => CAPABILITY_JOBS[capability]);

const identifiers = (job: ClaimedJob) => {
  try {
    return parseVersionedIdentifierPayload(job.payload).identifiers;
  } catch {
    throw new TaskError("malformed_payload");
  }
};

const buildTask = async (deps: HomeTaskDeps, job: ClaimedJob): Promise<HomeTask | "done"> => {
  const ids = identifiers(job);
  const base = { jobId: job.id, leaseToken: job.leaseToken };
  if (job.name === "direct_scenes") {
    if (!ids.scriptId) throw new TaskError("direction_script_id_missing");
    const { input, context } = await prepareDirection(deps, job.workspaceId, ids.scriptId);
    return {
      kind: "direct_scenes",
      ...base,
      input,
      ...(context.format === "long" ? { longForm: true as const } : {}),
    };
  }
  if (job.name === "generate_plates") {
    if (!ids.nicheId) throw new TaskError("plate_niche_id_missing");
    const { missing } = await missingPlateRequests(deps, job.workspaceId, ids.nicheId);
    if (missing.length === 0) return "done";
    return {
      kind: "generate_plates",
      ...base,
      requests: missing.slice(0, PLATES_PER_TASK).map((request) => ({
        key: request.key,
        prompt: request.prompt,
        ...(request.size ? { size: request.size } : {}),
      })),
    };
  }
  if (job.name === "review_frames") {
    if (!ids.renderId) throw new TaskError("review_render_id_missing");
    const { manifest, asset } = await reviewableRender(deps, job.workspaceId, ids.renderId);
    const download = await deps.store.createDownload({
      workspaceId: job.workspaceId,
      assetId: asset.id,
    });
    return {
      kind: "review_frames",
      ...base,
      videoUrl: download.url,
      frames: keyFramePlan(manifest.scenes),
    };
  }
  if (job.name === "draft_offer_copy") {
    if (!ids.contentItemId) throw new TaskError("copy_content_item_id_missing");
    const { copy, item, offer, facts, niche, channels } = await prepareOfferCopy(
      deps,
      job.workspaceId,
      ids.contentItemId,
    );
    if (
      await offerCopyBuilt(
        copy.build,
        job.workspaceId,
        item,
        channelIdsOf(channels),
        jobAfterCopy(deps, job.workspaceId, item),
      )
    )
      return "done";
    const productId = productIdFromOffer(offer);
    // Buyer voice sharpens the copy but is optional: a provider hiccup must not block drafting.
    const voice = productId
      ? await copy
          .catalogForWorkspace(job.workspaceId)
          ?.readBuyerVoice(productId)
          .catch(() => null)
      : null;
    const artDirection = artDirectionContextOf(niche.context, offer.title);
    return {
      kind: "draft_offer_copy",
      ...base,
      input: buildOfferCopyInput({
        title: offer.title,
        facts,
        voice: voice ?? null,
        niche,
        channels: [...channels.keys()],
        seed: item.id,
        ...(mainCharacterName(niche.context)
          ? { characterName: mainCharacterName(niche.context) as string }
          : {}),
      }),
      validation: {
        sourceFactKeys: item.sourceFactKeys,
        captionMaxLength: captionLimitsOf(channels),
      },
      ...(artDirection ? { artDirection } : {}),
    };
  }
  if (job.name === "generate_clips") {
    if (!ids.renderId) throw new TaskError("clip_render_id_missing");
    const prep = await prepareClips(deps, job.workspaceId, ids.renderId);
    if (!prep.scene) {
      await finishClips(prep, job.workspaceId);
      return "done";
    }
    const plan = await planClip(deps, job.workspaceId, prep, prep.scene);
    const download = await deps.store.createDownload({
      workspaceId: job.workspaceId,
      assetId: plan.reference.id,
    });
    return {
      kind: "generate_clips",
      ...base,
      sceneIndex: prep.scene.index,
      prompt: plan.prompt,
      negativePrompt: plan.negativePrompt,
      referenceUrl: download.url,
      profile: plan.profile,
    };
  }
  if (job.name === "generate_offer_scenes") {
    if (!ids.contentItemId) throw new TaskError("scene_content_item_id_missing");
    return buildOfferScenesTask(deps, job, ids.contentItemId);
  }
  if (job.name === "check_scene_fidelity") {
    if (!ids.assetId) throw new TaskError("fidelity_asset_id_missing");
    return buildSceneFidelityTask(deps, job, ids.assetId, ids.contentItemId);
  }
  if (job.name === "check_narration") {
    if (!deps.narration) throw new TaskError("narration_not_configured");
    return buildNarrationTask(deps.narration, job, ids);
  }
  throw new TaskError("job_not_for_home");
};

/** Every scene has a clip or a static fallback: the render can go on. Idempotent per render attempt. */
const finishClips = async (prep: ClipPrep, workspaceId: WorkspaceId): Promise<void> => {
  await prep.clips.jobs.enqueue(
    createRenderLongFormJob({
      workspaceId,
      renderId: prep.render.id,
      attempt: prep.render.attempt,
    }),
  );
};

/**
 * Claims the next job this token may run, in its workspace only, and returns its task. Jobs
 * that cannot become a task fail permanently (or complete, when there is nothing left to do)
 * and the next one is tried; at most `maxSkips` per call.
 */
export const claimHomeTask = async (
  deps: HomeTaskDeps,
  token: HomeWorkerToken,
  maxSkips = 5,
  /** The model the machine has loaded: its jobs go first, so the GPU does not swap per task. */
  loaded?: HomeCapability,
): Promise<HomeTask | null> => {
  const preferNames =
    loaded && token.capabilities.includes(loaded) ? CAPABILITY_JOBS[loaded] : undefined;
  for (let i = 0; i <= maxSkips; i += 1) {
    const job = await deps.queue.claim({
      workerId: `home:${token.id}`,
      leaseDurationMs: deps.leaseDurationMs,
      names: jobsFor(token),
      workspaceId: token.workspaceId,
      ...(preferNames ? { preferNames } : {}),
    });
    if (!job) return null;
    const lease = { id: job.id, workspaceId: job.workspaceId, leaseToken: job.leaseToken };
    try {
      const task = await buildTask(deps, job);
      if (task !== "done") return task;
      await deps.queue.complete(lease);
    } catch (error) {
      if (!(error instanceof TaskError)) {
        // Do not hold the lease (and the workspace's local-AI slot) for a server-side fault.
        await deps.queue
          .retry({ ...lease, reason: "home_task_build_failed" })
          .catch(() => undefined);
        throw error;
      }
      if (error.message === "already_reviewed" || error.message === "already_checked")
        await deps.queue.complete(lease);
      else await deps.queue.failPermanently({ ...lease, reason: error.message });
    }
  }
  return null;
};

// ------------------------------------------------------------------ apply

export type ApplyOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

const leased = async (
  deps: HomeTaskDeps,
  token: HomeWorkerToken,
  input: Readonly<{ jobId: string; leaseToken: string }>,
): Promise<ClaimedJob | null> => {
  const job = await deps.queue.takeLease({
    id: input.jobId,
    workspaceId: token.workspaceId,
    leaseToken: input.leaseToken,
  });
  return job && jobsFor(token).includes(job.name) ? job : null;
};

/**
 * Applies a posted result to the task it answers. Every result is re-validated server side; an
 * invalid result fails the job permanently and writes nothing.
 */
export const applyHomeResult = async (
  deps: HomeTaskDeps,
  token: HomeWorkerToken,
  input: Readonly<{
    jobId: string;
    leaseToken: string;
    result: HomeResult;
    /** What the machine says it runs; recorded, never trusted. */
    workerVersion?: string | undefined;
  }>,
): Promise<ApplyOutcome> => {
  const job = await leased(deps, token, input);
  if (!job) return { ok: false, reason: "task_not_leased" };
  const lease = { id: job.id, workspaceId: job.workspaceId, leaseToken: job.leaseToken };
  if (job.name !== input.result.kind) {
    // The lease was just taken, so the machine cannot fail the task itself any more.
    await deps.queue.failPermanently({ ...lease, reason: "result_kind_mismatch" });
    return { ok: false, reason: "result_kind_mismatch" };
  }
  const ids = identifiers(job);
  try {
    if (input.result.kind === "generate_offer_scenes") {
      await applyOfferScenes(
        deps,
        token,
        job,
        ids.contentItemId ?? "",
        input.result,
        input.workerVersion,
      );
    } else if (input.result.kind === "check_narration") {
      if (!deps.narration) throw new TaskError("narration_not_configured");
      await applyNarration(deps.narration, job, ids, input.result);
    } else if (input.result.kind === "check_scene_fidelity") {
      await applySceneFidelity(
        deps,
        token,
        job,
        ids.assetId ?? "",
        input.result,
        ids.contentItemId,
      );
    } else if (input.result.kind === "generate_clips") {
      const result = input.result;
      const prep = await prepareClips(deps, job.workspaceId, ids.renderId ?? "");
      const scene = prep.scene;
      if (!scene || scene.index !== result.sceneIndex) throw new TaskError("clip_scene_mismatch");
      if (!clipModelAllowed(result.model)) throw new TaskError("clip_model_not_allowlisted");
      const plan = await planClip(deps, job.workspaceId, prep, scene);
      const attempts = prep.states[String(scene.index)]?.attempts ?? 0;
      const write = (state: SceneClipState) =>
        prep.clips.clipState.write({
          workspaceId: job.workspaceId,
          storyboardId: prep.board.id,
          sceneIndex: scene.index,
          state,
        });
      const checked = await clipFault(prep.clips, plan.profile, result);
      if ("code" in checked) {
        const lastError = `clip_rejected:${checked.code}`;
        if (attempts + 1 < MAX_CLIP_ATTEMPTS) {
          await write({ status: "queued", attempts: attempts + 1, lastError });
          throw new RetryableTaskError(lastError);
        }
        await write({ status: "fallback_static", attempts: attempts + 1, lastError });
      } else {
        const stored = await prep.clips.cache.getOrProduce({
          workspaceId: job.workspaceId,
          stage: SCENE_CLIP_STAGE,
          version: result.model,
          inputs: {
            local: true,
            prompt: plan.prompt,
            negativePrompt: plan.negativePrompt,
            profile: plan.profile,
            references: [plan.reference.checksum],
          },
          produce: async () => ({
            bytes: checked.mp4,
            mimeType: "video/mp4",
            metadata: {
              width: plan.profile.width,
              height: plan.profile.height,
              frames: plan.profile.frames,
              fps: plan.profile.fps,
              model: result.model,
              // The server cannot prove which model drew the pixels; the declaration is recorded.
              homeWorker: {
                tokenId: token.id,
                tokenPrefix: token.prefix,
                jobId: job.id,
                declaredModel: result.model,
                runtime: result.provenance?.runtime ?? "unknown",
                ...(result.provenance?.observedModel
                  ? { observedModel: result.provenance.observedModel }
                  : {}),
                ...(result.provenance?.runtimeVersion
                  ? { runtimeVersion: result.provenance.runtimeVersion }
                  : {}),
                ...(input.workerVersion ? { workerVersion: input.workerVersion } : {}),
                receivedAt: deps.now().toISOString(),
                postedHash: sha256(result.bytes),
              },
            },
          }),
        });
        await write({
          status: "ready",
          assetId: stored.assetId,
          attempts,
          model: result.model,
        });
      }
      const next = prep.board.scenes.find(
        (candidate) =>
          candidate.index !== scene.index && !clipDone(prep.states[String(candidate.index)]),
      );
      // The job completes per scene: the next scene gets its own job, so progress burns no attempts.
      if (next)
        await prep.clips.jobs.enqueue(
          createGenerateClipsJob({
            workspaceId: job.workspaceId,
            renderId: prep.render.id,
            attempt: prep.render.attempt,
            sceneIndex: next.index,
          }),
        );
      else await finishClips(prep, job.workspaceId);
    } else if (input.result.kind === "direct_scenes") {
      const prepared = await prepareDirection(deps, job.workspaceId, ids.scriptId ?? "");
      const longForm = prepared.context.format === "long";
      const checked = (longForm ? checkLongFormOutput : checkDirectorOutput)(
        input.result.scenes,
        prepared.input,
      );
      if (!checked.ok) throw new TaskError(`director_${checked.failure.reason}`);
      if (
        longForm &&
        pacingBlocked(
          pacingReport({
            scenes: checked.scenes,
            body: prepared.script.body,
            language: prepared.script.language,
          }),
        )
      )
        throw new TaskError("pacing_blocked");
      const latest = await deps.storyboards.findLatestForScript({
        workspaceId: job.workspaceId,
        scriptId: prepared.script.id,
      });
      await deps.storyboards.create(
        createStoryboard({
          id: randomUUID(),
          workspaceId: job.workspaceId,
          script: prepared.script,
          version: (latest?.version ?? 0) + 1,
          renderer: "stickman_motion",
          scenes: checked.scenes,
          characters: prepared.context.characters,
          assets: [],
          voiceId: prepared.voiceId,
          musicTrackId: null,
          // YouTube long-form is 16:9; short-form stays vertical.
          canvas: longForm ? "landscape" : "portrait",
          actorId: prepared.script.actorId,
          longForm,
        }),
      );
    } else if (input.result.kind === "generate_plates") {
      const { niche, missing } = await missingPlateRequests(
        deps,
        job.workspaceId,
        ids.nicheId ?? "",
      );
      const byKey = new Map(missing.map((request) => [request.key, request]));
      const byPrompt = new Map<string, Awaited<ReturnType<SceneGenerator["generate"]>>>();
      for (const plate of input.result.plates) {
        const request = byKey.get(plate.key);
        if (!request) throw new TaskError("plate_key_unknown");
        if (
          !Object.hasOwn(LOCAL_GENERATOR_LICENSES, plate.model) ||
          !COMMERCIAL_USE_BY_PROVIDER.has(plate.model) ||
          modelPolicyFor(plate.model)?.capability !== "image_generation" ||
          !modelPolicyFor(plate.model)?.enabled
        )
          throw new TaskError("plate_model_not_allowlisted");
        if (plate.bytes.byteLength === 0 || plate.bytes.byteLength > MAX_PLATE_BYTES)
          throw new TaskError("plate_too_large");
        const image = await deps.reencodeImage(plate.bytes).catch(() => null);
        if (!image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg"))
          throw new TaskError("plate_unreadable");
        if (image.width < MIN_PLATE_PX || image.height < MIN_PLATE_PX)
          throw new TaskError("plate_too_small");
        if (image.width > MAX_PLATE_PX || image.height > MAX_PLATE_PX)
          throw new TaskError("plate_too_large");
        // The server cannot prove which model made the pixels, so every posted image is held for
        // a human decision (ADR 0012). A trusted_home_worker mode would skip the hold; there is
        // none yet. The stored asset checksum is the output hash.
        byPrompt.set(request.prompt, {
          bytes: image.bytes,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          neurons: 0,
          model: plate.model,
          license: `${LOCAL_GENERATOR_LICENSES[plate.model]} (declared ${plate.model}, home worker ${token.prefix})`,
          ...(plate.seed !== undefined ? { seed: plate.seed } : {}),
          review: {
            status: "pending_review",
            tokenId: token.id,
            tokenPrefix: token.prefix,
            jobId: job.id,
            capability: "image_generation",
            declaredModel: plate.model,
            ...(input.workerVersion ? { workerVersion: input.workerVersion } : {}),
            receivedAt: deps.now().toISOString(),
            inputHash: sha256(
              JSON.stringify({ prompt: request.prompt, size: request.size ?? null }),
            ),
            postedHash: sha256(plate.bytes),
            generation: {
              provider: "local",
              runtime: plate.provenance?.runtime ?? "unknown",
              ...(plate.provenance?.runtimeVersion
                ? { runtimeVersion: plate.provenance.runtimeVersion }
                : {}),
              expectedModel: modelPolicyFor(plate.model)?.expectedModel ?? plate.model,
              observedModel: plate.provenance?.observedModel ?? plate.model,
              quantization: modelPolicyFor(plate.model)?.quantization ?? null,
              promptHash: sha256(request.prompt),
              seed: plate.seed ?? null,
              width: image.width,
              height: image.height,
              generatedAt: deps.now().toISOString(),
              workerId: token.id,
              validationResult: "pending_review",
            },
          },
        });
      }
      // The posted images stand in for the generator; the bank does the rest (keys, rights,
      // post-processing, provenance) exactly as fill-scene-bank does.
      const generator: SceneGenerator = {
        generate: async (prompt) => {
          const image = byPrompt.get(prompt);
          if (!image) throw new Error("plate_not_posted");
          byPrompt.delete(prompt);
          return image;
        },
      };
      const posted = new Set(input.result.plates.map((plate) => plate.key));
      await fillSceneBank(
        { ...deps.bank, generator, ...(deps.postProcess ? { postProcess: deps.postProcess } : {}) },
        {
          workspaceId: job.workspaceId,
          niches: [niche],
          only: (request) => posted.has(request.key),
          local: true,
        },
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message === "plate_not_posted") return;
        throw error;
      });
    } else if (input.result.kind === "draft_offer_copy") {
      const { copy, item, offer, facts, niche, channels } = await prepareOfferCopy(
        deps,
        job.workspaceId,
        ids.contentItemId ?? "",
      );
      const policy = modelPolicyFor(input.result.model);
      if (
        policy?.capability !== "scene_director" ||
        policy.copywriting !== true ||
        policy.licensePolicy !== "commercial_allowed"
      )
        throw new TaskError("copy_model_not_allowlisted");
      // A repeat after a crash between building and completing must not create variants twice.
      const nextJob = jobAfterCopy(deps, job.workspaceId, item);
      if (
        !(await offerCopyBuilt(copy.build, job.workspaceId, item, channelIdsOf(channels), nextJob))
      ) {
        const checkContext = {
          facts,
          sourceFactKeys: item.sourceFactKeys,
          // The planned count depends on buyer voice fetched at build time; the API bounds it.
          slideCount: input.result.draft.slides.length,
          channels: [...channels.keys()],
          captionMaxLength: captionLimitsOf(channels),
          offerTitle: offer.title,
        };
        const verdict = checkOfferCopyDraft(input.result.draft, checkContext);
        if (!verdict.ok) throw new RetryableTaskError(`copy_rejected:${verdict.code}`);
        const chosen =
          (await pickOfferHook(
            deps,
            {
              workspaceId: job.workspaceId,
              itemId: item.id,
              offerTitle: offer.title,
              niche: niche.name,
              facts,
            },
            offerCopyHookCandidates(verdict, input.result.draft, checkContext),
          )) ?? verdict;
        const built = await buildPostCreatives(copy.build, {
          workspaceId: job.workspaceId,
          contentItemId: item.id,
          slides: withSceneLines(
            chosen.filled.slides,
            input.result.sceneLines,
            artDirectionContextOf(niche.context, offer.title),
          ),
          channelIds: [...channels.values()].map((channel) => channel.id),
          captions: Object.fromEntries(
            [...channels].map(([kind, channel]) => [channel.id, chosen.captions[kind] ?? ""]),
          ),
          nextJob,
        });
        if (!built.ok) throw new TaskError(`build_${built.error}`.slice(0, 150));
      }
    } else {
      const { qualityReport } = await reviewableRender(deps, job.workspaceId, ids.renderId ?? "");
      const scenes = new Set(
        (
          await deps.renders.findForWorkspace({
            workspaceId: job.workspaceId,
            renderId: ids.renderId ?? "",
          })
        )?.timingManifest?.scenes.map((scene) => scene.index) ?? [],
      );
      const review = input.result.review;
      if (review.findings.some((finding) => finding.severity === "BLOCK"))
        throw new TaskError("review_block_not_allowed");
      // Only what the in-process review can produce: vlm_<kind> ids, a scene, short notes. A home
      // machine must not plant findings that look like deterministic checks.
      if (
        review.findings.some(
          (finding) =>
            !VLM_FINDING_IDS.has(finding.id) ||
            finding.sceneIndex === undefined ||
            (finding.detail?.length ?? 0) > MAX_VLM_NOTE,
        )
      )
        throw new TaskError("review_finding_invalid");
      if (
        review.findings.some(
          (finding) => finding.sceneIndex !== undefined && !scenes.has(finding.sceneIndex),
        )
      )
        throw new TaskError("review_scene_unknown");
      const stored = await deps.renders.recordVisualReview({
        workspaceId: job.workspaceId,
        renderId: ids.renderId ?? "",
        visual: withVlmReview(qualityReport.visual ?? { findings: [], colorStrip: [] }, review),
      });
      if (!stored) throw new TaskError("render_not_reviewable");
    }
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    if (error instanceof RetryableTaskError)
      await deps.queue.retry({ ...lease, reason: error.message });
    else await deps.queue.failPermanently({ ...lease, reason: error.message });
    await recordHomeRun(deps.routes, {
      workspaceId: job.workspaceId,
      jobName: job.name,
      executor: executorOfToken(token),
      outcome: "failed",
      detail: error.message,
      now: new Date(),
    });
    return { ok: false, reason: error.message };
  }
  await deps.queue.complete(lease);
  await recordHomeRun(deps.routes, {
    workspaceId: job.workspaceId,
    jobName: job.name,
    executor: executorOfToken(token),
    outcome: "ok",
    detail: null,
    now: new Date(),
  });
  return { ok: true };
};

/** The home machine could not run the model step: retry later, or give up. */
export const failHomeTask = async (
  deps: HomeTaskDeps,
  token: HomeWorkerToken,
  input: Readonly<{ jobId: string; leaseToken: string; reason: string; retryable: boolean }>,
): Promise<ApplyOutcome> => {
  const job = await leased(deps, token, input);
  if (!job) return { ok: false, reason: "task_not_leased" };
  const lease = { id: job.id, workspaceId: job.workspaceId, leaseToken: job.leaseToken };
  const reason = `home:${input.reason.replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 80)}`;
  if (input.retryable) await deps.queue.retry({ ...lease, reason });
  else await deps.queue.failPermanently({ ...lease, reason });
  await recordHomeRun(deps.routes, {
    workspaceId: job.workspaceId,
    jobName: job.name,
    executor: executorOfToken(token),
    outcome: "failed",
    detail: reason,
    now: new Date(),
  });
  return { ok: true };
};
