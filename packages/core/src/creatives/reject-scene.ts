import type { UserId, WorkspaceId } from "@money-maker/contracts";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { ReviewReason } from "../content/approval.js";
import type { ContentVariant } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { createGenerateOfferScenesJob, type JobQueue } from "../jobs/job.js";
import type { ReelRenderRepository } from "../publishing/reel-render.js";
import { RENDERER_VERSION } from "./creative-renderer.js";
import {
  MAX_OWNER_SCENE_REJECTIONS,
  type OfferSceneCanvas,
  offerSceneMetadata,
  slotKey,
} from "./offer-scenes.js";

/**
 * Review Studio (owner brief 2026-10-08, section 23): the reviewer rejects one scene instead of
 * the package. The scene is archived with the reviewer's reasons, the item's variants go back to
 * draft with the render pending, and the slot gets one more attempt (an owner rejection does not
 * use up the slot's automatic attempts). A product complaint is recorded as the gate's own
 * `product_differs_from_reference`, so the redraw takes the real-composite repair when it can.
 */
export type RejectSceneDeps = Readonly<{
  content: Pick<
    ContentRepository,
    | "findContentItemForWorkspace"
    | "listVariantsForWorkspace"
    | "findVariantForWorkspace"
    | "updateVariant"
  >;
  assets: Pick<AssetRepository, "findForWorkspace" | "updateState"> &
    Required<Pick<AssetRepository, "updateMetadata" | "listByMetadata">>;
  jobs: Pick<JobQueue, "enqueue">;
  /** A Reel rendered from the old slides still shows the rejected scene: it stops being ready. */
  reels?: Pick<ReelRenderRepository, "invalidateReady">;
  now: () => Date;
}>;
export type RejectSceneInput = Readonly<{
  workspaceId: WorkspaceId;
  contentItemId: string;
  slideIndex: number;
  canvas: OfferSceneCanvas;
  reasons: readonly ReviewReason[];
  note: string;
  actorId: UserId;
}>;
export type RejectSceneResult =
  | Readonly<{ ok: true; sceneAssetId: string; attempt: number }>
  | Readonly<{
      ok: false;
      code: "not_found" | "no_scene" | "variant_locked" | "attempt_budget_spent";
    }>;

const EDITABLE: ReadonlySet<ContentVariant["state"]> = new Set([
  "draft",
  "ready_for_review",
  "rejected",
]);

export const rejectOfferScene = async (
  deps: RejectSceneDeps,
  input: RejectSceneInput,
): Promise<RejectSceneResult> => {
  const { workspaceId } = input;
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: input.contentItemId,
  });
  if (!item || item.workspaceId !== workspaceId) return { ok: false, code: "not_found" };
  const slide = item.creativeSlides?.find((entry) => entry.index === input.slideIndex);
  const sceneId =
    input.canvas === "story" ? slide?.storySceneAssetId : (slide?.sceneAssetId ?? undefined);
  if (!sceneId) return { ok: false, code: "no_scene" };
  const scene = await deps.assets.findForWorkspace({ workspaceId, assetId: sceneId });
  const meta = scene ? offerSceneMetadata(scene) : null;
  if (!scene || scene.workspaceId !== workspaceId || !meta || meta.contentItemId !== item.id)
    return { ok: false, code: "no_scene" };
  const variants = (await deps.content.listVariantsForWorkspace(workspaceId)).filter(
    (variant) => variant.contentItemId === item.id,
  );
  // Approved or published content is never reworked under the reviewer's feet.
  if (variants.some((variant) => !EDITABLE.has(variant.state)))
    return { ok: false, code: "variant_locked" };
  const slotScenes = (
    await Promise.all(
      (["active", "archived"] as const).map((state) =>
        deps.assets.listByMetadata({
          workspaceId,
          role: "offer_scene",
          key: "contentItemId",
          value: item.id,
          state,
        }),
      ),
    )
  )
    .flat()
    .filter((asset) => {
      const other = offerSceneMetadata(asset);
      return other !== null && slotKey(other) === slotKey(meta);
    });
  if (
    slotScenes.filter((asset) => asset.metadata?.ownerRejection).length >=
    MAX_OWNER_SCENE_REJECTIONS
  )
    return { ok: false, code: "attempt_budget_spent" };
  const at = deps.now().toISOString();
  const reasons = [
    ...(input.reasons.includes("BAD_PRODUCT") ? ["product_differs_from_reference"] : []),
    ...input.reasons.map((reason) => `owner_rejected:${reason}`),
  ];
  await deps.assets.updateMetadata({
    workspaceId,
    assetId: scene.id,
    patch: {
      ownerRejection: {
        reasons: reasons.length > 0 ? reasons : ["owner_rejected"],
        note: input.note.trim().slice(0, 500),
        actorId: input.actorId,
        at,
      },
    },
  });
  await deps.assets.updateState({ workspaceId, assetId: scene.id, state: "archived" });
  for (const listed of variants) {
    // Re-read right before writing: an approval that landed meanwhile is never undone.
    const variant = await deps.content.findVariantForWorkspace({
      workspaceId,
      variantId: listed.id,
    });
    if (!variant || !EDITABLE.has(variant.state)) continue;
    const { rejectionReason: _reason, approval: _approval, ...rest } = variant;
    await deps.content.updateVariant({
      ...rest,
      state: "draft",
      creativeRender: {
        state: "pending",
        reason: `scene_rejected:${slotKey(meta)}`,
        templateVersions: {},
        rendererVersion: RENDERER_VERSION,
        brandKitHash: "",
      },
    });
    await deps.reels?.invalidateReady({
      workspaceId,
      sourceVariantId: variant.id,
      reason: "stale_after_scene_reject",
    });
  }
  const attempt = meta.attempt + 1;
  await deps.jobs.enqueue(
    createGenerateOfferScenesJob({
      workspaceId,
      contentItemId: item.id,
      round: `owner:${slotKey(meta)}@${attempt}`,
    }),
  );
  return { ok: true, sceneAssetId: scene.id, attempt };
};
