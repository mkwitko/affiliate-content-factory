import type { WorkspaceId } from "@money-maker/contracts";
import { isPublishableChannelKind } from "../channels/channel.js";
import type { ChannelRepository } from "../channels/channel-repository.js";
import { createVariant, snapshotStillBacksContent } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { forbiddenClaimReason, verifyClaim } from "../content/claim-verifier.js";
import { numbersWithoutEvidence } from "../content/preview-content.js";
import { createRenderCreativesJob, type EnqueueJobInput, type JobQueue } from "../jobs/job.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import { RENDERER_VERSION } from "./creative-renderer.js";
import { deriveCreativeFeatures } from "./derive-creative-features.js";
import { priceDisplayFromFacts } from "./price-display.js";
import { validateSlideDeckQuality, validateSlideSpec, type SlideSpec } from "./slide-spec.js";

export type BuildPostCreativesDeps = Readonly<{
  contentRepository: ContentRepository;
  offerRepository: OfferRepository;
  channelRepository: ChannelRepository;
  jobQueue: JobQueue;
}>;

export type BuildPostCreativesInput = Readonly<{
  workspaceId: WorkspaceId;
  contentItemId: string;
  slides: readonly SlideSpec[];
  channelIds: readonly string[];
  /** channelId -> caption; channels without one keep the "Caption pending." placeholder. */
  captions?: Readonly<Record<string, string>>;
  /** The job that follows the build; default render_creatives (auto packages draw scenes first). */
  nextJob?: EnqueueJobInput;
}>;

export type BuildPostCreativesError =
  | "INVALID_ARGUMENTS"
  | "CONTENT_NOT_FOUND"
  | "OFFER_UNEXPECTED"
  | "OFFER_NOT_ACTIVE"
  | "OFFER_FACTS_CHANGED"
  | "INVALID_CONTENT"
  | "JOB_QUEUE_UNAVAILABLE"
  | `CREATIVE_QUALITY_REJECTED:${"generic_hook" | "repeated_slide_copy"}`
  | `CLAIM_WITHOUT_EVIDENCE:${string}`;

export type BuildPostCreativesResult =
  | Readonly<{ ok: true; value: Readonly<{ jobId: string; variantIds: Record<string, string> }> }>
  | Readonly<{ ok: false; error: BuildPostCreativesError }>;

const failMetadata = (reason: string) => ({
  state: "failed" as const,
  reason,
  templateVersions: {},
  rendererVersion: RENDERER_VERSION,
  brandKitHash: "",
});

export const buildPostCreatives = async (
  deps: BuildPostCreativesDeps,
  input: BuildPostCreativesInput,
): Promise<BuildPostCreativesResult> => {
  const { workspaceId, slides } = input;
  if (new Set(input.channelIds).size !== input.channelIds.length)
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: input.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (!item.offerId || !item.offerSnapshotId) return { ok: false, error: "OFFER_UNEXPECTED" };
  const offer = await deps.offerRepository.findForWorkspace({ workspaceId, offerId: item.offerId });
  if (!offer) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (offer.state !== "active") return { ok: false, error: "OFFER_NOT_ACTIVE" };
  if (!snapshotStillBacksContent(offer, item.offerSnapshotId, item.sourceFactKeys))
    return { ok: false, error: "OFFER_FACTS_CHANGED" };
  const snapshot = offer.snapshots.find((candidate) => candidate.id === item.offerSnapshotId);
  const facts = snapshot?.facts ?? [];
  const price = snapshot ? priceDisplayFromFacts(facts, snapshot) : null;
  if (slides.some((slide, index) => slide.index !== index + 1 || slide.total !== slides.length))
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const quality = validateSlideDeckQuality(slides);
  if (!quality.ok) return { ok: false, error: `CREATIVE_QUALITY_REJECTED:${quality.reason}` };
  for (const slide of slides) {
    const validity = validateSlideSpec(slide);
    if (!validity.ok) return { ok: false, error: "INVALID_CONTENT" };
    for (const claim of slide.claims) {
      if (
        claim.factKey &&
        (!item.sourceFactKeys.includes(claim.factKey) ||
          !facts.some((fact) => fact.key === claim.factKey))
      )
        return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${claim.text}` };
      // A valid key is not proof: the claim must state the fact it cites.
      if (
        claim.factKey &&
        verifyClaim(claim.text, facts, claim.factKey).reason === "fact_not_referenced"
      )
        return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${claim.text}` };
    }
    for (const text of [
      slide.headline,
      slide.body ?? "",
      slide.badge ?? "",
      ...slide.claims.map((claim) => claim.text),
    ]) {
      const unsupported =
        numbersWithoutEvidence(text, facts)[0] ??
        (forbiddenClaimReason(text, offer.title) ? text : undefined);
      if (unsupported) return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${unsupported}` };
    }
  }
  for (const caption of Object.values(input.captions ?? {})) {
    const unsupported =
      numbersWithoutEvidence(caption, facts)[0] ??
      (forbiddenClaimReason(caption, offer.title) ? caption.slice(0, 80) : undefined);
    if (unsupported) return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${unsupported}` };
  }

  const channels = await Promise.all(
    input.channelIds.map((channelId) =>
      deps.channelRepository.findForWorkspace({ workspaceId, channelId }),
    ),
  );
  if (
    channels.some(
      (channel) =>
        !channel || !isPublishableChannelKind(channel.kind) || channel.status !== "active",
    )
  )
    return { ok: false, error: "CONTENT_NOT_FOUND" };

  await deps.contentRepository.updateContentItem({ ...item, creativeSlides: slides });
  const variantIds: Record<string, string> = {};
  const variants = [];
  for (const channel of channels) {
    if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
    const variant = {
      ...createVariant({
        workspaceId,
        contentItem: item,
        channel,
        offer,
        assetIds: [],
        caption: input.captions?.[channel.id] ?? "Caption pending.",
        language: "pt-BR",
      }),
      creativeFeatures: deriveCreativeFeatures({ channelKind: channel.kind, slides, price }),
      creativeRender: {
        state: "pending" as const,
        templateVersions: {},
        rendererVersion: RENDERER_VERSION,
        brandKitHash: "",
      },
    };
    variants.push(variant);
    variantIds[channel.id] = (await deps.contentRepository.createVariant(variant)).id;
  }
  try {
    const job = await deps.jobQueue.enqueue(
      input.nextJob ??
        createRenderCreativesJob({ workspaceId, contentItemId: item.id, attempt: 1 }),
    );
    return { ok: true, value: { jobId: job.id, variantIds } };
  } catch {
    await Promise.all(
      variants.map((variant) =>
        deps.contentRepository.updateVariant({
          ...variant,
          creativeRender: failMetadata("job_queue_unavailable"),
        }),
      ),
    );
    return { ok: false, error: "JOB_QUEUE_UNAVAILABLE" };
  }
};
