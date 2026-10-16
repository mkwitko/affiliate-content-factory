import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import { offerDestination } from "@money-maker/core/offers/offer";
import {
  assetRightsFingerprint,
  createEditorialReview,
  type EditorialChecklist,
} from "@money-maker/core/content/editorial";
import { resolveAssetRights } from "@money-maker/core/assets/asset-rights";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const verdict = z.enum(["pass", "fail", "n/a"]);
const checklistSchema = z
  .object({
    originalAngle: verdict,
    meaningfulEditorialInput: verdict,
    visualVariation: verdict,
    sourceGrounding: verdict,
    rightsReviewed: verdict,
    disclosureDecisionReviewed: verdict,
    massProductionRisk: verdict,
    reusedContentRisk: verdict,
    editorialValueIndependentOfAffiliate: verdict,
  })
  .strict();
export const recordEditorialReviewInputSchema = z
  .object({
    workspaceId: z.uuid(),
    variantId: z.string().min(1).max(200),
    publicationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    checklist: checklistSchema,
    notes: z.string().max(4000).default(""),
  })
  .strict();

export const recordEditorialReviewTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordEditorialReviewInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const {
    editorialRepository,
    contentRepository,
    channelRepository,
    providerConnections,
    assetRepository,
    offerRepository,
  } = deps;
  if (
    !editorialRepository ||
    !contentRepository ||
    !channelRepository ||
    !providerConnections ||
    !assetRepository
  )
    throw new Error("Editorial review dependencies are not configured.");
  const variant = await contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const [item, channel] = await Promise.all([
    contentRepository.findContentItemForWorkspace({
      workspaceId,
      contentItemId: variant.contentItemId,
    }),
    channelRepository.findForWorkspace({ workspaceId, channelId: variant.channelId }),
  ]);
  if (!item || !channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (
    (item.offerId === null) !==
    (parsed.data.checklist.editorialValueIndependentOfAffiliate === "n/a")
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  if (channel.kind !== "youtube") return { ok: false, error: "CHANNEL_UNSUPPORTED" };
  if (!variant.publishSpec) return { ok: false, error: "PUBLISH_SPEC_MISSING" };
  const script = await editorialRepository.findScriptVersion({
    workspaceId,
    contentItemId: item.id,
  });
  if (!script || script.status !== "approved") return { ok: false, error: "SCRIPT_NOT_APPROVED" };
  const [connection, offer, assets] = await Promise.all([
    providerConnections.findForWorkspace({ workspaceId, connectionId: channel.connectionId }),
    item.offerId && offerRepository
      ? offerRepository.findForWorkspace({ workspaceId, offerId: item.offerId })
      : Promise.resolve(null),
    Promise.all(
      variant.assetIds.map((assetId) => assetRepository.findForWorkspace({ workspaceId, assetId })),
    ),
  ]);
  if (!connection || assets.some((asset) => !asset))
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  const thumbnail = variant.publishSpec?.thumbnailAssetId
    ? await assetRepository.findForWorkspace({
        workspaceId,
        assetId: variant.publishSpec.thumbnailAssetId,
      })
    : null;
  if (variant.publishSpec?.thumbnailAssetId && !thumbnail)
    return { ok: false, error: "THUMBNAIL_INVALID" };
  const destination = offer ? offerDestination(offer) : null;
  const fingerprint = publicationFingerprint({
    schemaVersion: 1,
    variantId: variant.id,
    channelId: channel.id,
    connectionId: connection.id,
    destinationFingerprint: destination ? destinationFingerprint(destination) : null,
    caption: variant.caption,
    publishSpec: variant.publishSpec ?? null,
    mediaAssetChecksums: assets.map((asset) => asset?.checksum ?? ""),
    thumbnailChecksum: thumbnail?.checksum ?? null,
    language: variant.language,
    voiceScript: variant.voiceScript,
  });
  if (fingerprint !== parsed.data.publicationFingerprint)
    return { ok: false, error: "EDITORIAL_REVIEW_STALE" };
  const rightsAssets = await resolveAssetRights({
    workspaceId,
    assets: [...assets.filter((asset) => asset !== null), ...(thumbnail ? [thumbnail] : [])],
    findAsset: (assetId) => assetRepository.findForWorkspace({ workspaceId, assetId }),
  });
  if (rightsAssets.some((asset) => asset.commercialUse !== true))
    return { ok: false, error: "RIGHTS_UNVERIFIED" };
  const review = createEditorialReview({
    workspaceId,
    variantId: variant.id,
    publicationFingerprint: fingerprint,
    rightsFingerprint: assetRightsFingerprint(rightsAssets),
    checklist: parsed.data.checklist as EditorialChecklist,
    verdict: Object.values(parsed.data.checklist).includes("fail") ? "fail" : "pass",
    notes: parsed.data.notes,
    reviewerId: actorId,
  });
  const stored = await editorialRepository.createReview(review);
  await deps.audit?.record({
    action: "content.editorial_review.recorded",
    workspaceId,
    actorUserId: actorId,
    targetType: "ContentEditorialReview",
    targetId: stored.id,
    metadata: {
      variantId: variant.id,
      publicationFingerprint: fingerprint,
      verdict: stored.verdict,
      reviewPolicyVersion: stored.reviewPolicyVersion,
    },
  });
  return { ok: true, value: { reviewId: stored.id, counting: stored.verdict === "pass" } };
};
