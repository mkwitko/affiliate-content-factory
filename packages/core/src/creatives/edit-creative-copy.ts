import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelRepository } from "../channels/channel-repository.js";
import type { ContentVariant } from "../content/content.js";
import { snapshotStillBacksContent } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { copyTextCode, finalizeOfferCaption, INSTAGRAM_CTA } from "../content/offer-copy.js";
import { numbersWithoutEvidence } from "../content/preview-content.js";
import { createRenderCreativesJob, type JobQueue } from "../jobs/job.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import type { ReelRenderRepository } from "../publishing/reel-render.js";
import { RENDERER_VERSION } from "./creative-renderer.js";
import { type SlideSpec, validateSlideDeckQuality, validateSlideSpec } from "./slide-spec.js";

export type EditCreativeCopyDeps = Readonly<{
  content: Pick<
    ContentRepository,
    | "findContentItemForWorkspace"
    | "updateContentItem"
    | "listVariantsForWorkspace"
    | "updateVariant"
  >;
  offers: Pick<OfferRepository, "findForWorkspace">;
  channels: Pick<ChannelRepository, "findForWorkspace">;
  jobs: Pick<JobQueue, "enqueue">;
  reels?: Pick<ReelRenderRepository, "invalidateReady">;
  now: () => Date;
}>;

export type EditCreativeCopyInput = Readonly<{
  workspaceId: WorkspaceId;
  contentItemId: string;
  slides?: readonly Readonly<{
    index: number;
    headline?: string | undefined;
    body?: string | undefined;
  }>[];
  captions?: readonly Readonly<{ variantId: string; caption: string }>[];
}>;

export type EditCreativeCopyResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        slidesChanged: boolean;
        rerenderQueued: boolean;
        reelsStale: boolean;
        captionVariantIds: readonly string[];
        slides: readonly SlideSpec[];
      }>;
    }>
  | Readonly<{ ok: false; error: string }>;

/** Only these variants can still change; approved, scheduled, published, rejected and cancelled cannot. */
const editable: readonly ContentVariant["state"][] = ["draft", "ready_for_review"];
const frozen: readonly ContentVariant["state"][] = ["approved", "scheduled", "published"];
const videoOnly: readonly string[] = ["instagram_reels", "tiktok_video"];

/**
 * edit_creative_copy: the owner changes slide text or a caption before approving. Prices and the
 * discount badge are derived, never editable; the same evidence gates as the original copy apply.
 * Approved (or scheduled/published) work is refused: reject it and rebuild instead, so an approval
 * never silently covers different text. Scene art stays pinned; only the render is queued again.
 */
export const editCreativeCopy = async (
  deps: EditCreativeCopyDeps,
  input: EditCreativeCopyInput,
): Promise<EditCreativeCopyResult> => {
  const { workspaceId } = input;
  if (!input.slides?.length && !input.captions?.length)
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: input.contentItemId,
  });
  if (!item || item.state !== "draft") return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (!item.offerId || !item.offerSnapshotId) return { ok: false, error: "OFFER_UNEXPECTED" };
  const offer = await deps.offers.findForWorkspace({ workspaceId, offerId: item.offerId });
  if (!offer) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (offer.state !== "active") return { ok: false, error: "OFFER_NOT_ACTIVE" };
  if (!snapshotStillBacksContent(offer, item.offerSnapshotId, item.sourceFactKeys))
    return { ok: false, error: "OFFER_FACTS_CHANGED" };
  const facts =
    offer.snapshots.find((snapshot) => snapshot.id === item.offerSnapshotId)?.facts ?? [];
  const variants = (await deps.content.listVariantsForWorkspace(workspaceId)).filter(
    (variant) => variant.contentItemId === item.id && variant.state !== "cancelled",
  );

  // Slides ------------------------------------------------------------------
  let slides = item.creativeSlides ?? [];
  let slidesChanged = false;
  const slideEdits = input.slides ?? [];
  if (slideEdits.length > 0) {
    if (slides.length === 0) return { ok: false, error: "CREATIVE_SLIDES_MISSING" };
    if (variants.some((variant) => frozen.includes(variant.state)))
      return { ok: false, error: "CONTENT_ALREADY_APPROVED" };
    if (new Set(slideEdits.map((edit) => edit.index)).size !== slideEdits.length)
      return { ok: false, error: "INVALID_ARGUMENTS" };
    const next = [...slides];
    for (const edit of slideEdits) {
      const at = next.findIndex((slide) => slide.index === edit.index);
      const current = next[at];
      if (!current) return { ok: false, error: "SLIDE_NOT_FOUND" };
      if (edit.headline === undefined && edit.body === undefined)
        return { ok: false, error: "INVALID_ARGUMENTS" };
      const { body: _oldBody, ...rest } = current;
      const body = edit.body === undefined ? current.body : edit.body.trim();
      next[at] = {
        ...rest,
        headline: (edit.headline ?? current.headline).trim(),
        ...(body ? { body } : {}),
      };
    }
    const quality = validateSlideDeckQuality(next);
    if (!quality.ok) return { ok: false, error: `CREATIVE_QUALITY_REJECTED:${quality.reason}` };
    for (const edit of slideEdits) {
      const slide = next.find((candidate) => candidate.index === edit.index);
      if (!slide) continue;
      const validity = validateSlideSpec(slide);
      if (!validity.ok) return { ok: false, error: `INVALID_CONTENT:${validity.reason}` };
      for (const text of [slide.headline, slide.body ?? ""]) {
        const unsupported = numbersWithoutEvidence(text, facts)[0];
        if (unsupported) return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${unsupported}` };
      }
      const code = copyTextCode([slide.headline, slide.body ?? ""], facts, offer.title);
      if (code) return { ok: false, error: `COPY_REJECTED:${code}` };
    }
    slides = next;
    slidesChanged = true;
  }

  // Captions ----------------------------------------------------------------
  const captionUpdates: ContentVariant[] = [];
  for (const edit of input.captions ?? []) {
    const variant = variants.find((candidate) => candidate.id === edit.variantId);
    if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
    if (!editable.includes(variant.state)) return { ok: false, error: "VARIANT_NOT_EDITABLE" };
    const channel = await deps.channels.findForWorkspace({
      workspaceId,
      channelId: variant.channelId,
    });
    if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
    const bare = edit.caption.replaceAll(INSTAGRAM_CTA, "").replace(/(^|\s)#publi\b/gi, "$1");
    const finalized = finalizeOfferCaption(bare, {
      channel: channel.kind,
      facts,
      maxLength: channel.capabilities.captionMaxLength,
    });
    if (!finalized.ok) return { ok: false, error: `COPY_REJECTED:${finalized.code}` };
    captionUpdates.push({ ...variant, caption: finalized.caption });
  }

  // Persist -----------------------------------------------------------------
  for (const variant of captionUpdates) await deps.content.updateVariant(variant);
  let rerenderQueued = false;
  let reelsStale = false;
  if (slidesChanged) {
    await deps.content.updateContentItem({ ...item, creativeSlides: slides });
    const render = {
      state: "pending" as const,
      templateVersions: {},
      rendererVersion: RENDERER_VERSION,
      brandKitHash: "",
    };
    for (const variant of variants) {
      const channel = await deps.channels.findForWorkspace({
        workspaceId,
        channelId: variant.channelId,
      });
      if (channel && videoOnly.includes(channel.kind)) {
        // The video was cut from the old slides: drop it so it cannot be approved stale.
        if (variant.assetIds.length > 0) {
          await deps.content.updateVariant({ ...variant, assetIds: [] });
          reelsStale = true;
        }
        continue;
      }
      const latest = captionUpdates.find((candidate) => candidate.id === variant.id) ?? variant;
      await deps.content.updateVariant({ ...latest, creativeRender: render });
      if (channel?.kind === "instagram_carousel")
        await deps.reels?.invalidateReady({
          workspaceId,
          sourceVariantId: variant.id,
          reason: "stale_after_copy_edit",
        });
    }
    // A new attempt number per edit keeps the job queue's idempotency key from swallowing it.
    await deps.jobs.enqueue(
      createRenderCreativesJob({
        workspaceId,
        contentItemId: item.id,
        attempt: deps.now().getTime(),
      }),
    );
    rerenderQueued = true;
  }
  return {
    ok: true,
    value: {
      slidesChanged,
      rerenderQueued,
      reelsStale,
      captionVariantIds: captionUpdates.map((variant) => variant.id),
      slides,
    },
  };
};
