import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type {
  SceneClipGenerator,
  SceneClipRequest,
} from "@money-maker/core/assets/scene-clip-generator";
import {
  SCENE_CLIP_STAGE,
  SceneClipSubmitError,
} from "@money-maker/core/assets/scene-clip-generator";
import type { StageCache, StageCacheResult } from "@money-maker/core/assets/stage-cache";
import { compileClipPrompt } from "@money-maker/core/content/clip-prompt";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import type {
  SceneClipState,
  SceneClipStateRepository,
} from "@money-maker/core/content/scene-clip-state";
import {
  type ClipScene,
  isClipStoryboard,
  isOwnedClipReference,
} from "@money-maker/core/content/storyboard";
import type { StoryboardRepository } from "@money-maker/core/content/storyboard-repository";
import { estimateNarrationSeconds } from "@money-maker/core/explainer/script-guards";
import {
  type JobIdentifierPayload,
  type JobQueue,
  RetryLaterJobError,
} from "@money-maker/core/jobs/job";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import {
  createGenerateClipsJob,
  createRenderLongFormJob,
  GENERATE_SCENE_CLIPS_MAX_ATTEMPTS,
  type LongFormRenderRepository,
  SCENE_CLIPS_DEADLINE_MS,
} from "@money-maker/core/publishing/long-form-render";

/** The only verified portrait size (spec 4.1); requested and checked clip dimensions. */
/** 2.5 Flash 9:16 output (wiki.agnes-ai.com); the clip check tolerates provider tiers. */
export const CLIP_SIZE = { width: 720, height: 1280 } as const;
const MIN_CLIP_SECONDS = 4;
const MAX_CLIP_SECONDS = 12;
const POLL_INTERVAL_MS = 45_000;
const MAX_ATTEMPTS_PER_SCENE = 4;
const MAX_IN_FLIGHT = 2;

export type ClipCheckResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
export type GenerateSceneClipsDependencies = Readonly<{
  storyboards: Pick<StoryboardRepository, "findForWorkspace">;
  scripts: Pick<EditorialRepository, "findScriptForWorkspace">;
  renders: Pick<LongFormRenderRepository, "findForWorkspace" | "recordFailed">;
  clipState: SceneClipStateRepository;
  content?: Pick<ContentRepository, "findContentItemForWorkspace">;
  offers?: Pick<OfferRepository, "findForWorkspace">;
  assets: Pick<AssetRepository, "findForWorkspace">;
  store: Pick<AssetStore, "createDownload">;
  /** Hosted generator; absent under local_only or when local clips are on (never called then). */
  generator?: SceneClipGenerator;
  /**
   * Local Wan clips (spec 2026-10-02, decision 7): enqueue one home-queue generate_clips job
   * instead of calling a hosted provider.
   */
  localClips?: boolean;
  /**
   * Paid cloud clips (Modal pilot): a scene the generator cannot deliver renders its reference
   * plate as a local zoom clip (`fallback_static`) instead of failing the whole render.
   */
  staticFallback?: boolean;
  /**
   * Run log of the clip route actually used (spec 2026-10-14). `code` is the failure code, or
   * `ok`. Must never throw; the caller wraps it.
   */
  onRun?: (code: string) => Promise<void>;
  /** The clip stage cache; clips are stored only through it (ruling 6). */
  cache: StageCache;
  /** Cache version: a model upgrade misses by construction. */
  model: string;
  /** Downloads a provider url immediately (INV-G5); the worker passes fetchSafeMedia. */
  fetchClip: (url: string) => Promise<Uint8Array>;
  checkClip: (
    bytes: Uint8Array,
    expected: Readonly<{ width: number; height: number; seconds: number }>,
  ) => Promise<ClipCheckResult>;
  jobs: Pick<JobQueue, "enqueue">;
  now?: () => Date;
  log?: (event: Readonly<Record<string, unknown>>) => void;
}>;

class CacheMiss extends Error {}

/**
 * One run is one short pass: poll stored tasks, resume queued scenes, submit within the cap, then
 * wait. The provider task id is written before the first poll and never cleared except by a
 * failed task, so a restart or a timeout never resubmits (INV-G4).
 */
export const createGenerateSceneClipsHandler =
  (deps: GenerateSceneClipsDependencies) =>
  async (job: { payload: JobIdentifierPayload; attemptCount?: number }): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    const renderId = identifiers.renderId;
    if (!renderId) throw new Error("long_form_render_id_missing");
    const now = deps.now ?? (() => new Date());
    const log = deps.log ?? (() => undefined);
    const render = await deps.renders.findForWorkspace({ workspaceId, renderId });
    if (!render || render.status !== "pending") return;
    const fail = async (reason: string) => {
      await deps.renders.recordFailed({ workspaceId, renderId, reason });
    };
    const board = await deps.storyboards.findForWorkspace({
      workspaceId,
      storyboardId: render.storyboardId,
    });
    if (!board || !isClipStoryboard(board)) return void (await fail("storyboard_not_ai_clips"));
    const script = await deps.scripts.findScriptForWorkspace({
      workspaceId,
      scriptId: board.scriptId,
    });
    if (!script || script.status !== "approved" || script.approvedChecksum !== script.checksum)
      return void (await fail("script_not_approved"));

    const item = await deps.content?.findContentItemForWorkspace({
      workspaceId,
      contentItemId: board.contentItemId,
    });
    const offer = item?.offerId
      ? await deps.offers?.findForWorkspace({ workspaceId, offerId: item.offerId })
      : null;
    const forbiddenTerms = offer ? [offer.title] : [];

    // Refuse every prompt before any provider call, so a late refusal never wastes earlier clips.
    const plans = new Map<number, Plan>();
    for (const scene of board.scenes) {
      const compiled = compileClipPrompt({
        clipPrompt: scene.clipPrompt,
        forbiddenTerms,
        ...(offer ? { offerTitle: offer.title } : {}),
      });
      if (!compiled.ok)
        return void (await fail(`clip_prompt_refused:${scene.index}:${compiled.reason}`));
      const seconds = Math.min(
        MAX_CLIP_SECONDS,
        Math.max(
          MIN_CLIP_SECONDS,
          Math.ceil(
            estimateNarrationSeconds(
              script.body.slice(scene.fromChar, scene.toChar),
              script.language,
            ),
          ),
        ),
      );
      plans.set(scene.index, {
        scene,
        prompt: compiled.prompt,
        negativePrompt: compiled.negativePrompt,
        seconds,
      });
    }

    if (deps.localClips) {
      const unreferenced = board.scenes.find((scene) => scene.referenceAssetId === undefined);
      if (unreferenced)
        return void (await fail(`local_clip_reference_required:${unreferenced.index}`));
      await deps.jobs.enqueue(
        createGenerateClipsJob({
          workspaceId,
          renderId,
          attempt: render.attempt,
          sceneIndex: board.scenes[0]?.index ?? 1,
        }),
      );
      return;
    }
    const generator = deps.generator;
    if (!generator) return void (await fail("scene_clips_unavailable"));

    const states: Record<string, SceneClipState> = {
      ...(await deps.clipState.read({ workspaceId, storyboardId: board.id })),
    };
    const stateOf = (index: number): SceneClipState =>
      states[String(index)] ?? { status: "queued", attempts: 0 };
    const save = async (index: number, state: SceneClipState) => {
      states[String(index)] = state;
      await deps.clipState.write({ workspaceId, storyboardId: board.id, sceneIndex: index, state });
    };
    /** True when the scene fell back to its plate and the run may continue. */
    const failScene = async (index: number, state: SceneClipState, code: string) => {
      if (deps.staticFallback && plans.get(index)?.scene.referenceAssetId !== undefined) {
        await save(index, { status: "fallback_static", attempts: state.attempts, lastError: code });
        log({ event: "scene_clip_fallback_static", sceneIndex: index, code });
        return true;
      }
      await save(index, { status: "failed", attempts: state.attempts, lastError: code });
      await fail(`scene_clip_failed:${index}:${code}`);
      return false;
    };
    /** A retryable failure clears the task id and backs off 2-10 minutes; attempts cap at 4. */
    const retryOrFail = async (
      index: number,
      attempts: number,
      code: string,
      retryable: boolean,
    ): Promise<boolean> => {
      await deps.onRun?.(code);
      // Paid cloud clips get one attempt: a retry would pay again.
      if (deps.staticFallback || !retryable || attempts >= MAX_ATTEMPTS_PER_SCENE)
        return failScene(index, { status: "queued", attempts }, code);
      const backoffMs = Math.min(10, 2 * 2 ** (attempts - 1)) * 60_000;
      await save(index, {
        status: "queued",
        attempts,
        lastError: code,
        nextAttemptAt: new Date(now().getTime() + backoffMs).toISOString(),
      });
      log({ event: "scene_clip_retry", sceneIndex: index, code, attempts });
      return true;
    };

    const requestFor = async (plan: Plan): Promise<RequestPlan | { error: string }> => {
      const reference = plan.scene.referenceAssetId;
      let referenceImageUrls: string[] = [];
      let referenceChecksums: string[] = [];
      if (reference !== undefined) {
        const asset = await deps.assets.findForWorkspace({ workspaceId, assetId: reference });
        if (!asset || !isOwnedClipReference(asset, workspaceId))
          return { error: `clip_reference_unavailable:${plan.scene.index}` };
        referenceImageUrls = [
          (await deps.store.createDownload({ workspaceId, assetId: asset.id })).url,
        ];
        referenceChecksums = [asset.checksum];
      }
      const request: SceneClipRequest = {
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        mode: referenceImageUrls.length > 0 ? "image" : "text",
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls, referenceChecksums } : {}),
        ...CLIP_SIZE,
        seconds: plan.seconds,
      };
      // Signed urls expire and differ per call; the asset checksums identify the reference.
      const cacheInputs = {
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        mode: request.mode,
        width: request.width,
        height: request.height,
        seconds: request.seconds,
        references: referenceChecksums,
      };
      return { request, cacheInputs };
    };
    const cacheRequest = (
      inputs: unknown,
      produce: () => Promise<{
        bytes: Uint8Array;
        mimeType: "video/mp4";
        metadata: Record<string, unknown>;
      }>,
    ) => ({
      workspaceId,
      stage: SCENE_CLIP_STAGE,
      version: deps.model,
      inputs,
      produce,
    });
    const lookup = async (inputs: unknown): Promise<StageCacheResult | null> => {
      try {
        return await deps.cache.getOrProduce(
          cacheRequest(inputs, async () => {
            throw new CacheMiss();
          }),
        );
      } catch (error) {
        if (error instanceof CacheMiss) return null;
        throw error;
      }
    };

    // Pass 1: poll tasks already submitted (frees capacity for pass 2).
    for (const plan of plans.values()) {
      const index = plan.scene.index;
      const state = stateOf(index);
      if (state.status === "failed")
        return void (await fail(`scene_clip_failed:${index}:${state.lastError ?? "unknown"}`));
      if (state.status !== "submitted" || !state.providerTaskId) continue;
      const polled = await generator.poll({
        providerTaskId: state.providerTaskId,
        model: state.model ?? deps.model,
        ...(state.submittedAt ? { submittedAt: state.submittedAt } : {}),
      });
      if (polled.status === "pending") continue;
      if (polled.status === "failed") {
        if (!(await retryOrFail(index, state.attempts, polled.code, polled.retryable))) return;
        continue;
      }
      const built = await requestFor(plan);
      if ("error" in built) return void (await fail(built.error));
      try {
        const stored = await deps.cache.getOrProduce(
          cacheRequest(built.cacheInputs, async () => {
            const bytes = await deps.fetchClip(polled.url);
            const verdict = await deps.checkClip(bytes, { ...CLIP_SIZE, seconds: plan.seconds });
            if (!verdict.ok) throw new Error(`clip_check_failed:${verdict.reason}`);
            return {
              bytes,
              mimeType: "video/mp4",
              metadata: { ...CLIP_SIZE, seconds: plan.seconds, model: deps.model },
            };
          }),
        );
        await save(index, {
          status: "ready",
          assetId: stored.assetId,
          attempts: state.attempts,
          ...(state.model ? { model: state.model } : {}),
        });
        await deps.onRun?.("ok");
      } catch (error) {
        const code =
          error instanceof Error && error.message.startsWith("clip_check_failed:")
            ? error.message
            : "clip_download_failed";
        if (!(await retryOrFail(index, state.attempts, code, true))) return;
      }
    }

    // Pass 2: resume queued scenes, submitting within the in-flight cap.
    let inFlight = [...plans.keys()].filter(
      (index) => stateOf(index).status === "submitted",
    ).length;
    for (const plan of plans.values()) {
      const index = plan.scene.index;
      const state = stateOf(index);
      if (state.status !== "queued") continue;
      if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now().getTime()) continue;
      const built = await requestFor(plan);
      if ("error" in built) return void (await fail(built.error));
      const hit = await lookup(built.cacheInputs);
      if (hit) {
        await save(index, { status: "ready", assetId: hit.assetId, attempts: state.attempts });
        continue;
      }
      if (inFlight >= MAX_IN_FLIGHT) continue;
      const attempts = state.attempts + 1;
      try {
        const task = await generator.submit({
          ...built.request,
          budget: {
            workspaceId,
            operationKey: `scene-clip:${renderId}:${render.attempt}:${index}:${attempts}`,
          },
        });
        await save(index, {
          status: "submitted",
          providerTaskId: task.providerTaskId,
          model: task.model,
          ...(task.submittedAt
            ? { submittedAt: task.submittedAt }
            : { submittedAt: now().toISOString() }),
          attempts,
        });
        inFlight += 1;
      } catch (error) {
        const refused = error instanceof SceneClipSubmitError;
        if (
          !(await retryOrFail(
            index,
            attempts,
            refused ? error.code : "submit_failed",
            refused ? error.retryable : true,
          ))
        )
          return;
      }
    }

    const done = (status: SceneClipState["status"]) =>
      status === "ready" || status === "fallback_static";
    if ([...plans.keys()].every((index) => done(stateOf(index).status))) {
      await deps.jobs.enqueue(
        createRenderLongFormJob({ workspaceId, renderId, attempt: render.attempt }),
      );
      return;
    }
    if (
      (job.attemptCount ?? 1) >= GENERATE_SCENE_CLIPS_MAX_ATTEMPTS ||
      now().getTime() - render.createdAt.getTime() >= SCENE_CLIPS_DEADLINE_MS
    )
      return void (await fail("scene_clips_timeout"));
    // Wake at the earliest pending scene's next poll or backoff time.
    const pollAt = now().getTime() + POLL_INTERVAL_MS;
    const wakeAt = Math.min(
      ...[...plans.keys()].flatMap((index) => {
        const state = stateOf(index);
        if (done(state.status)) return [];
        const due =
          state.status === "queued" && state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : NaN;
        return [due > now().getTime() ? due : pollAt];
      }),
    );
    throw new RetryLaterJobError("scene_clips_pending", new Date(wakeAt));
  };

type Plan = Readonly<{ scene: ClipScene; prompt: string; negativePrompt: string; seconds: number }>;
type RequestPlan = Readonly<{ request: SceneClipRequest; cacheInputs: unknown }>;
