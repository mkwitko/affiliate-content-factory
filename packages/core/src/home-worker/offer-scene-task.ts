import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import {
  type Asset,
  COMMERCIAL_USE_BY_PROVIDER,
  createAsset,
  LOCAL_GENERATOR_LICENSES,
} from "../assets/asset.js";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import { modelPolicyFor } from "../assets/model-policy.js";
import { type ContentItem, snapshotStillBacksContent } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { isAutoSaleItem } from "../content/offer-package.js";
import { parseAffiliateBible } from "../creatives/affiliate-character-bible.js";
import type { CanonicalProduct } from "../creatives/canonical-product.js";
import { RENDERER_VERSION } from "../creatives/creative-renderer.js";
import {
  type ColourEvidence,
  isCountCritical,
  judgeInSceneFidelity,
  type ProductVisualSpec,
  parseReferenceAnswer,
  parseVlmFidelityAnswer,
  productVisualSpecFor,
} from "../creatives/in-scene-fidelity.js";
import {
  colourName,
  compileOfferScenePrompt,
  expectedPeopleFor,
  OFFER_SCENE_PROMPT_VERSION,
  OFFER_SCENE_SIZE,
  type OfferSceneProgress,
  type OfferSceneSlot,
  offerSceneMetadata,
  offerSceneProgress,
  offerSceneSeed,
  offerSceneSlots,
  productFailed,
  slotKey,
} from "../creatives/offer-scenes.js";
import { pickReference, type ReferenceEvidence } from "../creatives/reference-pick.js";
import { defaultSceneLine, shotFor } from "../creatives/scene-direction.js";
import type { SlideSpec } from "../creatives/slide-spec.js";
import {
  type ClaimedJob,
  createCheckSceneFidelityJob,
  createGenerateOfferScenesJob,
  createRenderCreativesJob,
  type JobQueue,
} from "../jobs/job.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import { productIdFromOffer } from "../offers/offer.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import { RetryableTaskError, TaskError } from "./task-error.js";
import type { HomeWorkerToken } from "./tokens.js";

/**
 * D1 generate_offer_scenes (image_editing) and D2 check_scene_fidelity (visual_qa) for auto
 * packages (plan 2026-10-06). State lives only in `offer_scene` asset metadata: pending until the
 * automatic fidelity gate passes (owner decision 2026-10-06: it replaces manual scene review),
 * archived when blocked. No table, no migration.
 */
export type OfferSceneDeps = Readonly<{
  offers: Pick<OfferRepository, "findForWorkspace">;
  content: Pick<
    ContentRepository,
    "updateContentItem" | "listVariantsForWorkspace" | "updateVariant"
  >;
  assets: Pick<AssetRepository, "findForWorkspace" | "create" | "updateState"> &
    Required<Pick<AssetRepository, "listByMetadata" | "updateMetadata" | "updateRights">>;
  store: Pick<AssetStore, "putObject" | "createDownload">;
  jobs: Pick<JobQueue, "enqueue">;
  /** Downloads a signed asset URL (server side). */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Dominant colours of the product photo (providers, sharp), background excluded. */
  productColours: (
    reference: Uint8Array,
  ) => Promise<readonly (readonly [number, number, number])[]>;
  /** Colour evidence of the product photo against the scene (providers, sharp). */
  colourEvidence: (reference: Uint8Array, scene: Uint8Array) => Promise<ColourEvidence>;
  /** Sharpness, background and size of a listing photo (providers, sharp); absent = first photo. */
  referenceEvidence?: ((bytes: Uint8Array) => Promise<ReferenceEvidence>) | undefined;
  /**
   * Art-directed shots per slide template (scene-direction.ts: hands close-up, product hero
   * without people...). Off keeps the copy-as-moment prompt that always draws the character.
   * Opt-in (OFFER_SCENE_DIRECTION) until the owner judges a directed package.
   */
  direction?: boolean | undefined;
  /**
   * Real-composite path (Phase 3, brief 11.3): with direction on, the product-only slots of a
   * count-critical product draw only a backdrop and get the listing photo's cut-out composited
   * on it, so the count is the real one. Absent, or when the photo yields no clean cut-out
   * (framed canonical), those slots are drawn as before.
   */
  composite?:
    | Readonly<{
        canonical: (input: {
          workspaceId: WorkspaceId;
          productId: string;
          sourceAssets: readonly Asset[];
        }) => Promise<CanonicalProduct>;
        compose: (
          scene: Uint8Array,
          cutout: Uint8Array,
          options: Readonly<{ floor: boolean }>,
        ) => Promise<Uint8Array>;
      }>
    | undefined;
}>;

type Deps = Readonly<{
  content: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
  reencodeImage: (
    bytes: Uint8Array,
  ) => Promise<Readonly<{ bytes: Uint8Array; mimeType: string; width: number; height: number }>>;
  offerScenes?: OfferSceneDeps | undefined;
  now: () => Date;
}>;

export type OfferSceneTask = Readonly<{
  kind: "generate_offer_scenes";
  jobId: string;
  leaseToken: string;
  /** Signed downloads, in prompt order: [main character sheet, product photo]. */
  referenceUrls: readonly string[];
  scenes: readonly Readonly<{
    key: string;
    prompt: string;
    seed: number;
    size: Readonly<{ width: number; height: number }>;
  }>[];
}>;
export type SceneFidelityTask = Readonly<{
  kind: "check_scene_fidelity";
  jobId: string;
  leaseToken: string;
  sceneUrl: string;
  /** The product photo the scene was drawn from (image 1 of the VLM prompt). */
  referenceUrl: string;
  spec: ProductVisualSpec;
  /** Names the product in the scene-only placement question. */
  offerTitle: string;
  /**
   * What is judged: a drawn scene against the photo (default), the canonical cut-out alone
   * (counts), or a listing photo alone (clean single product, brief 11.1). The machine asks
   * the matching question; the server parses and judges.
   */
  mode?: "scene" | "cutout" | "reference";
}>;
type Provenance = Readonly<{ runtime: string; observedModel?: string; runtimeVersion?: string }>;
export type OfferSceneResult = Readonly<{
  kind: "generate_offer_scenes";
  scenes: readonly Readonly<{
    key: string;
    bytes: Uint8Array;
    model: string;
    seed: number;
    provenance?: Provenance;
    /** Optional relative depth map of this scene (grey PNG, white = near), for 2.5D Reels. */
    depth?: Uint8Array;
    /**
     * SHA-256 of the prompt the machine drew from. The requests are compiled again at apply
     * time; a verdict that landed in between (reference or cut-out check) can change them, and
     * a scene drawn from another prompt is redrawn rather than stored under the wrong record.
     * Absent from older workers.
     */
    promptSha256?: string;
  }>[];
}>;

/** The only depth model the home worker runs (scripts/local-ai/depth.py). */
export const DEPTH_MODEL = "depth-anything-v2-small";
const DEPTH_LICENSE = "Apache-2.0";
export type SceneFidelityResult = Readonly<{
  kind: "check_scene_fidelity";
  /** The VLM's JSON, validated strictly here; anything else retries and never passes. */
  answer: unknown;
  model: string;
  provenance?: Provenance;
}>;

// ponytail: scenes travel inline like plates; upload URLs if feeds outgrow three per task.
export const OFFER_SCENES_PER_TASK = 3;
export const MAX_SCENE_BYTES = 10_000_000;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const usableImage = (asset: Asset | null, workspaceId: WorkspaceId): asset is Asset =>
  asset !== null &&
  asset.workspaceId === workspaceId &&
  asset.state === "active" &&
  asset.mimeType.startsWith("image/");
const scenesOf = (deps: Deps): OfferSceneDeps => {
  if (!deps.offerScenes) throw new Error("offer_scenes_unavailable");
  return deps.offerScenes;
};

const listScenes = async (scenes: OfferSceneDeps, workspaceId: WorkspaceId, itemId: string) =>
  (
    await Promise.all(
      (["pending", "active", "archived"] as const).map((state) =>
        scenes.assets.listByMetadata({
          workspaceId,
          role: "offer_scene",
          key: "contentItemId",
          value: itemId,
          state,
        }),
      ),
    )
  )
    .flat()
    .filter((asset) => asset.workspaceId === workspaceId);

const offerContext = async (
  deps: Deps,
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  itemId: string,
) => {
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: itemId,
  });
  if (!item?.offerId || !item.offerSnapshotId || !isAutoSaleItem(item))
    throw new TaskError("offer_scene_item_not_auto");
  const slides = item.creativeSlides ?? [];
  if (slides.length === 0) throw new TaskError("creative_slides_missing");
  const offer = await scenes.offers.findForWorkspace({ workspaceId, offerId: item.offerId });
  if (offer?.state !== "active") throw new TaskError("offer_not_active");
  if (!snapshotStillBacksContent(offer, item.offerSnapshotId, item.sourceFactKeys))
    throw new TaskError("offer_facts_changed");
  const facts = offer.snapshots.find((entry) => entry.id === item.offerSnapshotId)?.facts ?? [];
  return { item, slides, offer, spec: productVisualSpecFor(offer.title, facts) };
};

// ponytail: measures up to six photos per compile; cache the pick on the item if it ever shows.
const MAX_REFERENCE_CANDIDATES = 6;

/**
 * The listing photo the editor draws from: the sharpest, largest, cleanest of the usable ones
 * (brief 11.1), measured by the provider; without a measurer, or when any measurement fails,
 * the first usable photo as before.
 */
const pickProductReference = async (
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  item: ContentItem,
): Promise<Asset | null> => {
  const usable: Asset[] = [];
  for (const assetId of item.sourcePictureAssetIds ?? []) {
    const found = await scenes.assets.findForWorkspace({ workspaceId, assetId });
    if (usableImage(found, workspaceId)) usable.push(found);
    if (usable.length >= MAX_REFERENCE_CANDIDATES) break;
  }
  // Photos the VLM has not seen yet get their check queued (idempotent per asset); photos it
  // called not clean are skipped once any clean one exists, and never lend their colours.
  const verdict = (asset: Asset) => {
    const check = asset.metadata?.referenceCheck;
    return isRecord(check) && typeof check.clean === "boolean" ? check.clean : null;
  };
  for (const asset of usable.filter((entry) => verdict(entry) === null))
    await scenes.jobs.enqueue(
      createCheckSceneFidelityJob({ workspaceId, assetId: asset.id, contentItemId: item.id }),
    );
  const clean = usable.filter((asset) => verdict(asset) === true);
  const pool = clean.length > 0 ? clean : usable;
  const first = pool[0] ?? null;
  const measure = scenes.referenceEvidence;
  if (!measure || pool.length < 2) return first;
  const candidates = await Promise.all(
    pool.map(async (asset) => {
      const download = await scenes.store.createDownload({ workspaceId, assetId: asset.id });
      return { id: asset, evidence: await measure(await scenes.fetchBytes(download.url)) };
    }),
  ).catch(() => null);
  return candidates ? (pickReference(candidates)?.id ?? first) : first;
};

/** Main character sheet + the picked listing photo, or why the item cannot get scenes. */
const references = async (
  deps: Deps,
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  item: ContentItem,
) => {
  const niche = await deps.niches.findForWorkspace({ workspaceId, nicheId: item.nicheId });
  if (niche?.state !== "active") throw new TaskError("niche_unavailable");
  const context = niche.context ?? {};
  const cast: unknown[] = Array.isArray(context.characters) ? context.characters : [];
  const main = cast.find(
    (entry): entry is { name: string; description: string; referenceAssetIds: [string] } =>
      isRecord(entry) &&
      entry.role === "main" &&
      typeof entry.name === "string" &&
      typeof entry.description === "string" &&
      Array.isArray(entry.referenceAssetIds) &&
      typeof entry.referenceAssetIds[0] === "string",
  );
  if (!main) return { ok: false, fallback: "main_character_sheet_missing" } as const;
  const sheet = await scenes.assets.findForWorkspace({
    workspaceId,
    assetId: main.referenceAssetIds[0],
  });
  if (!usableImage(sheet, workspaceId))
    return { ok: false, fallback: "main_character_sheet_unavailable" } as const;
  const product = await pickProductReference(scenes, workspaceId, item);
  if (!product) return { ok: false, fallback: "product_photo_unavailable" } as const;
  return {
    ok: true as const,
    character: {
      name: main.name,
      description: main.description,
      bible: parseAffiliateBible((main as { affiliateBible?: unknown }).affiliateBible),
    },
    storyWorld: typeof context.storyWorld === "string" ? context.storyWorld : undefined,
    sheet,
    product,
  };
};

const planScenes = async (deps: Deps, workspaceId: WorkspaceId, itemId: string) => {
  const scenes = scenesOf(deps);
  const context = await offerContext(deps, scenes, workspaceId, itemId);
  const progress = offerSceneProgress(
    offerSceneSlots(context.slides.length),
    await listScenes(scenes, workspaceId, itemId),
  );
  return { scenes, ...context, progress };
};
type Plan = Awaited<ReturnType<typeof planScenes>>;

/**
 * The cut-out asset id for the composite slots, or null when the photo gives none or the
 * cut-out is not yet known to be clean. Composite slots are the product-only shots of a
 * count-critical product, and (localized repair) any product-only shot whose last attempt drew
 * the wrong product: the redraw keeps the scene and puts the real product in it. Listing photos are often collages (2026-10-09: loaded
 * rack, empty rack and a room inset on one white background), so the VLM counts the cut-out
 * alone first (`cutoutCheck` on the canonical asset, through the fidelity task); until that
 * verdict is in, the slot is drawn as before.
 */
const cutoutFor = async (
  plan: Plan,
  workspaceId: WorkspaceId,
  photo: Asset,
): Promise<string | null> => {
  const composite = plan.scenes.composite;
  const productId = productIdFromOffer(plan.offer);
  const repair = plan.progress.needed.some((entry) => productFailed(entry.previousReasons));
  if (!composite || !plan.scenes.direction || !productId) return null;
  if (!isCountCritical(plan.spec) && !repair) return null;
  const canonical = await composite
    .canonical({ workspaceId, productId, sourceAssets: [photo] })
    .catch(() => null);
  if (canonical?.mode !== "cutout") return null;
  const asset = await plan.scenes.assets.findForWorkspace({
    workspaceId,
    assetId: canonical.assetId,
  });
  const check = asset?.metadata?.cutoutCheck;
  if (isRecord(check)) return check.verdict === "pass" ? canonical.assetId : null;
  await plan.scenes.jobs.enqueue(
    createCheckSceneFidelityJob({
      workspaceId,
      assetId: canonical.assetId,
      contentItemId: plan.item.id,
    }),
  );
  return null;
};

/** The prompts of the slots still needed; colours are measured from the stored product photo. */
const compileRequests = async (deps: Deps, plan: Plan, workspaceId: WorkspaceId) => {
  const refs = await references(deps, plan.scenes, workspaceId, plan.item);
  if (!refs.ok) return refs;
  const cutoutAssetId = await cutoutFor(plan, workspaceId, refs.product);
  const download = await plan.scenes.store.createDownload({
    workspaceId,
    assetId: refs.product.id,
  });
  // A photo the VLM called not clean (collage, styled scene) states no colours: the measured
  // ones were the kitchen's, not the product's (porta-tempero 2026-10-09).
  const photoCheck = refs.product.metadata?.referenceCheck;
  const colourNames =
    isRecord(photoCheck) && photoCheck.clean === false
      ? []
      : (await plan.scenes.productColours(await plan.scenes.fetchBytes(download.url))).map(
          colourName,
        );
  const requests = plan.progress.needed.flatMap(({ slot, attempt, previousReasons }) => {
    const slide = plan.slides[slot.slideIndex - 1];
    if (!slide) return [];
    // The shot is part of the plan: it decides the line and how many people the gate allows.
    const shot = shotFor(slide, isCountCritical(plan.spec));
    const direction = plan.scenes.direction
      ? {
          line:
            slide.sceneLine ??
            defaultSceneLine(shot, {
              character: refs.character,
              world: refs.storyWorld ?? "the place at home where it is used",
            }),
          people: shot.people,
          backdrop:
            cutoutAssetId !== null &&
            shot.people === 0 &&
            (isCountCritical(plan.spec) || productFailed(previousReasons)),
        }
      : undefined;
    return [
      {
        key: slotKey(slot),
        slot,
        attempt,
        cutoutAssetId: direction?.backdrop ? cutoutAssetId : null,
        people: expectedPeopleFor({ direction }),
        prompt: compileOfferScenePrompt({
          canvas: slot.canvas,
          storyWorld: refs.storyWorld,
          character: refs.character,
          moment: { headline: slide.headline, body: slide.body },
          direction,
          offerTitle: plan.offer.title,
          spec: plan.spec,
          colourNames,
        }),
        seed: offerSceneSeed(plan.item.id, slot, attempt),
        size: OFFER_SCENE_SIZE[slot.canvas],
      },
    ];
  });
  return { ok: true as const, refs, requests: requests.slice(0, OFFER_SCENES_PER_TASK) };
};

const rendered = async (scenes: OfferSceneDeps, workspaceId: WorkspaceId, itemId: string) =>
  (await scenes.content.listVariantsForWorkspace(workspaceId)).some(
    (variant) => variant.contentItemId === itemId && variant.creativeRender?.state === "rendered",
  );

/** Records on the item's variants why the render is not (fully) in-scene; once per prefix. */
const markVariants = async (
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  itemId: string,
  reason: string,
) => {
  const prefix = reason.split(":", 1)[0] ?? reason;
  for (const variant of await scenes.content.listVariantsForWorkspace(workspaceId))
    if (variant.contentItemId === itemId && !variant.creativeRender?.reason?.startsWith(prefix))
      await scenes.content.updateVariant({
        ...variant,
        creativeRender: {
          state: "pending",
          reason: reason.slice(0, 200),
          templateVersions: {},
          rendererVersion: RENDERER_VERSION,
          brandKitHash: "",
        },
      });
};

/**
 * The render job for this exact set of pinned scenes. The queue keeps idempotency keys forever,
 * so a fixed attempt would swallow the re-render after a reviewer rejects a scene; the same pins
 * (a duplicate finish) still map to the same key.
 */
const renderJobFor = (workspaceId: WorkspaceId, item: ContentItem, slides: readonly SlideSpec[]) =>
  createRenderCreativesJob({
    workspaceId,
    contentItemId: item.id,
    attempt: Number.parseInt(
      sha256(
        slides.map((s) => `${s.sceneAssetId ?? ""}/${s.storySceneAssetId ?? ""}`).join(","),
      ).slice(0, 12),
      16,
    ),
  });

/** No slot passed (or none can be drawn): render the cut-out path and say why. */
const fallBack = async (
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  item: ContentItem,
  reason: string,
) => {
  if (await rendered(scenes, workspaceId, item.id)) return;
  await markVariants(scenes, workspaceId, item.id, `in_scene_fallback:${reason}`);
  // A scene a reviewer rejected must not stay pinned: the render would refuse the archived asset.
  const creativeSlides = (item.creativeSlides ?? []).map(
    ({ sceneAssetId: _feed, storySceneAssetId: _story, ...slide }) => slide,
  );
  await scenes.content.updateContentItem({ ...item, creativeSlides });
  await scenes.jobs.enqueue(renderJobFor(workspaceId, item, creativeSlides));
};

/**
 * Pins the passing scenes on their slides and renders (idempotent per item). With `partial`,
 * the slots that failed every attempt render cut-out while the approved scenes stay (owner brief
 * 2026-10-08: repair the one bad scene, never discard the package).
 */
const finish = async (
  scenes: OfferSceneDeps,
  workspaceId: WorkspaceId,
  item: ContentItem,
  slides: readonly SlideSpec[],
  progress: OfferSceneProgress,
  partial?: string,
) => {
  if (partial) await markVariants(scenes, workspaceId, item.id, `in_scene_partial:${partial}`);
  const creativeSlides = slides.map(
    ({ sceneAssetId: _feed, storySceneAssetId: _story, ...slide }) => {
      // Scene ids are re-pinned from the progress: a slot whose scene a reviewer rejected and
      // that never passed again renders cut-out, never from the archived scene.
      const feed = progress.passed.get(slotKey({ slideIndex: slide.index, canvas: "feed" }));
      const story =
        slide.index === 1
          ? progress.passed.get(slotKey({ slideIndex: 1, canvas: "story" }))
          : undefined;
      return {
        ...slide,
        ...(feed ? { sceneAssetId: feed } : {}),
        ...(story ? { storySceneAssetId: story } : {}),
      };
    },
  );
  await scenes.content.updateContentItem({ ...item, creativeSlides });
  await scenes.jobs.enqueue(renderJobFor(workspaceId, item, creativeSlides));
};

const roundOf = (entry: Readonly<{ slot: OfferSceneSlot; attempt: number }>) =>
  `${slotKey(entry.slot)}@${entry.attempt}`;

/**
 * Where the item stands: every slot passed renders in-scene; every slot settled (nothing pending
 * or still drawable) renders partial or falls back; anything else keeps drawing.
 */
const settle = async (
  plan: Pick<Plan, "scenes" | "item" | "slides" | "progress">,
  workspaceId: WorkspaceId,
  reason: string,
): Promise<"done" | "draw"> => {
  const { scenes, item, slides, progress } = plan;
  if (progress.complete) {
    await finish(scenes, workspaceId, item, slides, progress);
    return "done";
  }
  if (progress.pending.length > 0 || progress.needed.length > 0) return "draw";
  const exhausted = `attempts_exhausted:${progress.exhausted.map(slotKey).join(",")}${
    reason ? `:${reason}` : ""
  }`;
  if (progress.passed.size > 0)
    await finish(scenes, workspaceId, item, slides, progress, exhausted);
  else await fallBack(scenes, workspaceId, item, exhausted);
  return "done";
};

// ------------------------------------------------------------------ D1

export const buildOfferScenesTask = async (
  deps: Deps,
  job: ClaimedJob,
  itemId: string,
): Promise<OfferSceneTask | "done"> => {
  const workspaceId = job.workspaceId;
  const plan = await planScenes(deps, workspaceId, itemId);
  if (await rendered(plan.scenes, workspaceId, itemId)) return "done";
  if ((await settle(plan, workspaceId, "")) === "done") return "done";
  // A crash between storing a scene and enqueueing its check must not strand it.
  for (const asset of plan.progress.pending)
    await plan.scenes.jobs.enqueue(createCheckSceneFidelityJob({ workspaceId, assetId: asset.id }));
  if (plan.progress.needed.length === 0) return "done";
  const compiled = await compileRequests(deps, plan, workspaceId);
  if (!compiled.ok) {
    await fallBack(plan.scenes, workspaceId, plan.item, compiled.fallback);
    return "done";
  }
  const urls = await Promise.all(
    [compiled.refs.sheet, compiled.refs.product].map(
      async (asset) =>
        (await plan.scenes.store.createDownload({ workspaceId, assetId: asset.id })).url,
    ),
  );
  return {
    kind: "generate_offer_scenes",
    jobId: job.id,
    leaseToken: job.leaseToken,
    referenceUrls: urls,
    scenes: compiled.requests.map((request) => ({
      key: request.key,
      prompt: request.prompt,
      seed: request.seed,
      size: request.size,
    })),
  };
};

const composeScene = async (
  plan: Plan,
  workspaceId: WorkspaceId,
  cutoutAssetId: string,
  scene: Readonly<{ bytes: Uint8Array; mimeType: string; width: number; height: number }>,
) => {
  const composite = plan.scenes.composite;
  if (!composite) throw new TaskError("scene_composite_unavailable");
  const download = await plan.scenes.store.createDownload({ workspaceId, assetId: cutoutAssetId });
  const cutout = await plan.scenes.fetchBytes(download.url);
  const bytes = await composite
    .compose(scene.bytes, cutout, { floor: plan.spec.standsOnFloor === true })
    .catch(() => null);
  if (!bytes) {
    // Never strand the package: the cut-out is marked unusable and the job goes back to the
    // queue, so its next claim compiles product-drawing prompts for these slots.
    const asset = await plan.scenes.assets.findForWorkspace({
      workspaceId,
      assetId: cutoutAssetId,
    });
    const previous = isRecord(asset?.metadata?.cutoutCheck) ? asset.metadata.cutoutCheck : {};
    await plan.scenes.assets.updateMetadata({
      workspaceId,
      assetId: cutoutAssetId,
      patch: { cutoutCheck: { ...previous, verdict: "block", reasons: ["composite_failed"] } },
    });
    throw new RetryableTaskError("scene_composite_failed");
  }
  return { ...scene, bytes, mimeType: "image/png" as const };
};

export const applyOfferScenes = async (
  deps: Deps,
  token: HomeWorkerToken,
  job: ClaimedJob,
  itemId: string,
  result: OfferSceneResult,
  workerVersion: string | undefined,
): Promise<void> => {
  const workspaceId = job.workspaceId;
  const plan = await planScenes(deps, workspaceId, itemId);
  const compiled = await compileRequests(deps, plan, workspaceId);
  if (!compiled.ok) throw new TaskError(`offer_scenes_${compiled.fallback}`);
  const byKey = new Map(compiled.requests.map((request) => [request.key, request]));
  const checked = [];
  const posted = new Set<string>();
  for (const scene of result.scenes) {
    const request = byKey.get(scene.key);
    if (!request || posted.has(scene.key)) throw new TaskError("scene_key_unknown");
    if (scene.promptSha256 && scene.promptSha256 !== sha256(request.prompt))
      throw new RetryableTaskError("scene_round_changed");
    posted.add(scene.key);
    const policy = modelPolicyFor(scene.model);
    if (
      policy?.capability !== "image_editing" ||
      !policy.enabled ||
      !Object.hasOwn(LOCAL_GENERATOR_LICENSES, scene.model) ||
      !COMMERCIAL_USE_BY_PROVIDER.has(scene.model)
    )
      throw new TaskError("scene_model_not_allowlisted");
    if (scene.seed !== request.seed) throw new TaskError("scene_seed_mismatch");
    if (scene.bytes.byteLength === 0 || scene.bytes.byteLength > MAX_SCENE_BYTES)
      throw new TaskError("scene_too_large");
    const image = await deps.reencodeImage(scene.bytes).catch(() => null);
    if (!image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg"))
      throw new TaskError("scene_unreadable");
    // The home worker may post the scene upscaled x2 (Real-ESRGAN); any other size is refused.
    const scale =
      image.width === request.size.width && image.height === request.size.height
        ? 1
        : image.width === request.size.width * 2 && image.height === request.size.height * 2
          ? 2
          : null;
    if (scale === null) throw new TaskError("scene_size_mismatch");
    // Composite slot: the real cut-out goes on the drawn backdrop before anything is stored,
    // so the fidelity gate judges the picture the slide will show.
    const composed = request.cutoutAssetId
      ? await composeScene(plan, workspaceId, request.cutoutAssetId, image)
      : image;
    // Depth is an optional extra: a bad map is dropped (the Reel falls back to Ken Burns), the
    // scene still counts.
    const depth =
      scene.depth && scene.depth.byteLength <= MAX_SCENE_BYTES
        ? await deps.reencodeImage(scene.depth).catch(() => null)
        : null;
    const depthOk =
      depth?.mimeType === "image/png" &&
      depth.width === image.width &&
      depth.height === image.height;
    checked.push({ scene, request, image: composed, scale, depth: depthOk ? depth : null });
  }
  // Every posted scene is valid: only now write. Pending (unusable) until D2 passes it.
  for (const { scene, request, image, scale, depth } of checked) {
    let depthAssetId: string | undefined;
    if (depth) {
      const depthChecksum = sha256(depth.bytes);
      const depthAsset = createAsset({
        workspaceId,
        mimeType: depth.mimeType,
        checksum: depthChecksum,
        width: depth.width,
        height: depth.height,
        provenance: "generated",
        creator: DEPTH_MODEL,
        commercialUse: null,
        license: `${DEPTH_LICENSE} (${DEPTH_MODEL}, home worker ${token.prefix})`,
        metadata: {
          role: "scene_depth",
          contentItemId: plan.item.id,
          slideIndex: request.slot.slideIndex,
          canvas: request.slot.canvas,
        },
      });
      if (!depthAsset.ok) throw new Error(`scene_depth_asset_invalid:${depthAsset.code}`);
      await plan.scenes.store.putObject({
        workspaceId,
        assetId: depthAsset.asset.id,
        mimeType: depthAsset.asset.mimeType,
        checksum: depthChecksum,
        width: depthAsset.asset.width,
        height: depthAsset.asset.height,
        bytes: depth.bytes,
      });
      await plan.scenes.assets.create(depthAsset.asset);
      depthAssetId = depthAsset.asset.id;
    }
    const checksum = sha256(image.bytes);
    const created = createAsset({
      workspaceId,
      mimeType: image.mimeType,
      checksum,
      width: image.width,
      height: image.height,
      provenance: "generated",
      creator: scene.model,
      commercialUse: null,
      license: `${LOCAL_GENERATOR_LICENSES[scene.model]} (declared ${scene.model}, home worker ${token.prefix})`,
      metadata: {
        role: "offer_scene",
        contentItemId: plan.item.id,
        slideIndex: request.slot.slideIndex,
        canvas: request.slot.canvas,
        attempt: request.attempt,
        expectedPeople: request.people,
        model: scene.model,
        seed: scene.seed,
        promptHash: sha256(request.prompt),
        promptVersion: OFFER_SCENE_PROMPT_VERSION,
        referenceAssetIds: [compiled.refs.sheet.id, compiled.refs.product.id],
        ...(request.cutoutAssetId
          ? { productMode: "composite", canonicalAssetId: request.cutoutAssetId }
          : {}),
        ...(depthAssetId ? { depthAssetId } : {}),
        ...(scale === 2 ? { upscale: "realesr-animevideov3-x2" } : {}),
        homeWorker: {
          status: "pending_fidelity",
          tokenId: token.id,
          tokenPrefix: token.prefix,
          jobId: job.id,
          capability: "image_editing",
          declaredModel: scene.model,
          runtime: scene.provenance?.runtime ?? "unknown",
          ...(scene.provenance?.observedModel
            ? { observedModel: scene.provenance.observedModel }
            : {}),
          ...(scene.provenance?.runtimeVersion
            ? { runtimeVersion: scene.provenance.runtimeVersion }
            : {}),
          ...(workerVersion ? { workerVersion } : {}),
          receivedAt: deps.now().toISOString(),
          postedHash: sha256(scene.bytes),
        },
      },
    });
    if (!created.ok) throw new Error(`offer_scene_asset_invalid:${created.code}`);
    await plan.scenes.store.putObject({
      workspaceId,
      assetId: created.asset.id,
      mimeType: created.asset.mimeType,
      checksum,
      width: created.asset.width,
      height: created.asset.height,
      bytes: image.bytes,
    });
    await plan.scenes.assets.create(created.asset);
    await plan.scenes.jobs.enqueue(
      createCheckSceneFidelityJob({ workspaceId, assetId: created.asset.id }),
    );
  }
  // The rest of the slots get their own job, so progress burns no attempts.
  const next = plan.progress.needed.find((entry) => !posted.has(slotKey(entry.slot)));
  if (next)
    await plan.scenes.jobs.enqueue(
      createGenerateOfferScenesJob({ workspaceId, contentItemId: itemId, round: roundOf(next) }),
    );
};

// ------------------------------------------------------------------ D2

const fidelityContext = async (
  deps: Deps,
  workspaceId: WorkspaceId,
  assetId: string,
  contentItemId?: string,
) => {
  const scenes = scenesOf(deps);
  const asset = await scenes.assets.findForWorkspace({ workspaceId, assetId });
  if (!asset || asset.workspaceId !== workspaceId || !asset.mimeType.startsWith("image/"))
    throw new TaskError("offer_scene_not_found");
  // Reference check: a listing photo of the item, judged alone (clean single product).
  if (contentItemId) {
    const context = await offerContext(deps, scenes, workspaceId, contentItemId);
    if ((context.item.sourcePictureAssetIds ?? []).includes(asset.id)) {
      if (asset.metadata?.referenceCheck !== undefined) return null;
      return { scenes, asset, product: asset, mode: "reference" as const, ...context };
    }
  }
  // Cut-out check: the canonical product itself is the "scene", its listing photo the reference.
  if (asset.metadata?.role === "canonical_product" && contentItemId) {
    if (asset.metadata.cutoutCheck !== undefined) return null;
    const context = await offerContext(deps, scenes, workspaceId, contentItemId);
    const sourceId = asset.metadata.sourceAssetId;
    const product =
      typeof sourceId === "string"
        ? await scenes.assets.findForWorkspace({ workspaceId, assetId: sourceId })
        : null;
    if (!usableImage(product, workspaceId)) throw new TaskError("product_reference_unavailable");
    return { scenes, asset, product, mode: "cutout" as const, ...context };
  }
  const meta = offerSceneMetadata(asset);
  if (!meta) throw new TaskError("offer_scene_not_found");
  if (asset.state !== "pending" || asset.metadata?.inSceneFidelity !== undefined) return null;
  const context = await offerContext(deps, scenes, workspaceId, meta.contentItemId);
  const ids = asset.metadata?.referenceAssetIds;
  const productId = Array.isArray(ids) && typeof ids[1] === "string" ? ids[1] : null;
  const product = productId
    ? await scenes.assets.findForWorkspace({ workspaceId, assetId: productId })
    : null;
  if (!usableImage(product, workspaceId)) throw new TaskError("product_reference_unavailable");
  return { scenes, asset, product, mode: "scene" as const, ...context };
};

export const buildSceneFidelityTask = async (
  deps: Deps,
  job: ClaimedJob,
  assetId: string,
  contentItemId?: string,
): Promise<SceneFidelityTask | "done"> => {
  const context = await fidelityContext(deps, job.workspaceId, assetId, contentItemId);
  if (!context) return "done";
  const [scene, reference] = await Promise.all(
    [context.asset, context.product].map((asset) =>
      context.scenes.store.createDownload({ workspaceId: job.workspaceId, assetId: asset.id }),
    ),
  );
  return {
    kind: "check_scene_fidelity",
    jobId: job.id,
    leaseToken: job.leaseToken,
    sceneUrl: scene?.url ?? "",
    referenceUrl: reference?.url ?? "",
    spec: context.spec,
    offerTitle: context.offer.title,
    mode: context.mode,
  };
};

export const applySceneFidelity = async (
  deps: Deps,
  token: HomeWorkerToken,
  job: ClaimedJob,
  assetId: string,
  result: SceneFidelityResult,
  contentItemId?: string,
): Promise<void> => {
  const workspaceId = job.workspaceId;
  const context = await fidelityContext(deps, workspaceId, assetId, contentItemId);
  if (!context) throw new TaskError("scene_already_checked");
  const { scenes, asset, spec } = context;
  const policy = modelPolicyFor(result.model);
  if (
    policy?.capability !== "visual_qa" ||
    !policy.enabled ||
    policy.licensePolicy !== "commercial_allowed"
  )
    throw new TaskError("fidelity_model_not_allowlisted");
  if (context.mode === "reference") {
    const check = parseReferenceAnswer(result.answer);
    if (!check) throw new RetryableTaskError("fidelity_answer_invalid");
    await scenes.assets.updateMetadata({
      workspaceId,
      assetId: asset.id,
      patch: {
        referenceCheck: {
          ...check,
          model: result.model,
          checkedAt: deps.now().toISOString(),
          jobId: job.id,
        },
      },
    });
    return;
  }
  const vlm = parseVlmFidelityAnswer(result.answer, spec);
  if (!vlm) throw new RetryableTaskError("fidelity_answer_invalid");
  // Colour evidence is measured here, from the stored bytes, never taken from the machine.
  const colour = await Promise.all(
    [context.product, asset].map(async (entry) =>
      scenes.fetchBytes(
        (await scenes.store.createDownload({ workspaceId, assetId: entry.id })).url,
      ),
    ),
  )
    .then(([reference, scene]) =>
      reference && scene ? scenes.colourEvidence(reference, scene) : null,
    )
    .catch(() => null);
  if (!colour) throw new RetryableTaskError("colour_evidence_failed");
  if (context.mode === "cutout") {
    // A clean cut-out shows the product alone with its real count; a collage counts more.
    const judgedCutout = judgeInSceneFidelity({ spec, vlm, colour, expectedPeople: 0 });
    await scenes.assets.updateMetadata({
      workspaceId,
      assetId: asset.id,
      patch: {
        cutoutCheck: {
          verdict: judgedCutout.verdict,
          reasons: judgedCutout.reasons,
          counts: vlm.counts,
          model: result.model,
          checkedAt: deps.now().toISOString(),
          jobId: job.id,
        },
      },
    });
    return;
  }
  // The people allowance was fixed when the prompt was compiled; scenes stored before it existed
  // were all drawn with the character, so they allow one.
  const judged = judgeInSceneFidelity({
    spec,
    vlm,
    colour,
    expectedPeople: asset.metadata?.expectedPeople === 0 ? 0 : 1,
  });
  const pass = judged.verdict === "pass";
  const at = deps.now().toISOString();
  const previous = isRecord(asset.metadata?.homeWorker) ? asset.metadata.homeWorker : {};
  await scenes.assets.updateMetadata({
    workspaceId,
    assetId: asset.id,
    patch: {
      inSceneFidelity: {
        vlm,
        colour,
        verdict: judged.verdict,
        reasons: judged.reasons,
        model: result.model,
        checkedAt: at,
        jobId: job.id,
        tokenId: token.id,
      },
      homeWorker: {
        ...previous,
        status: pass ? "approved" : "rejected",
        // Owner decision 2026-10-06: the automatic gate replaces manual review of these scenes.
        reviewedBy: "automatic_fidelity_gate",
        reviewedAt: at,
      },
    },
  });
  if (pass) {
    await scenes.assets.updateRights({
      workspaceId,
      assetId: asset.id,
      commercialUse: COMMERCIAL_USE_BY_PROVIDER.has(asset.creator ?? "") ? true : null,
      license: asset.license,
    });
  }
  // State last: never usable before the verdict and rights are recorded. A "review" verdict
  // (a count the VLM could not read) is not a pass either: it is redrawn like a block.
  await scenes.assets.updateState({
    workspaceId,
    assetId: asset.id,
    state: pass ? "active" : "archived",
  });
  if (await rendered(scenes, workspaceId, context.item.id)) return;
  const progress = offerSceneProgress(
    offerSceneSlots(context.slides.length),
    await listScenes(scenes, workspaceId, context.item.id),
  );
  const settled = await settle(
    { scenes, item: context.item, slides: context.slides, progress },
    workspaceId,
    judged.reasons.join(","),
  );
  if (settled === "done") return;
  const next = progress.needed[0];
  if (next)
    await scenes.jobs.enqueue(
      createGenerateOfferScenesJob({
        workspaceId,
        contentItemId: context.item.id,
        round: roundOf(next),
      }),
    );
};
