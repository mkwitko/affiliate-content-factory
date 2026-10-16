import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { approveVariant, submitForReview } from "@money-maker/core/content/approval";
import { validateVariantForReview } from "@money-maker/core/content/content";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import { offerDestination } from "@money-maker/core/offers/offer";
import { assertTikTokShopPublishable } from "@money-maker/core/channels/tiktok-shop-status";
import {
  assetRightsFingerprint,
  isCountingEditorialReview,
} from "@money-maker/core/content/editorial";
import {
  findGeneratedClip,
  findUnverifiedGeneratedClip,
  hasAiDisclosure,
  resolveAssetRights,
} from "@money-maker/core/assets/asset-rights";
import { prepublishScoreFor } from "../../prepublish.js";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

export const approveContentInputSchema = z
  .object({ workspaceId: z.uuid(), variantId: z.string().trim().min(1).max(200) })
  .strict()
  .describe(
    "Approve one exact content variant using current workspace assets and policy. Accepts a draft: it is submitted for review and approved in the same call.",
  );

export const approveContentTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = approveContentInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles: ["owner", "operator", "reviewer"],
  });
  if (!authorization.ok) return { ok: false, error: "FORBIDDEN" };
  const {
    contentRepository,
    assetRepository,
    publicationPolicyRepository,
    channelRepository,
    offerRepository,
    providerConnections,
  } = dependencies;
  if (
    !contentRepository ||
    !assetRepository ||
    !publicationPolicyRepository ||
    !channelRepository ||
    !providerConnections
  ) {
    throw new Error("Approval dependencies are not configured.");
  }
  const found = await contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!found) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (found.state !== "draft" && found.state !== "rejected" && found.state !== "ready_for_review") {
    return { ok: false, error: "INVALID_CONTENT" };
  }
  const assets = (
    await Promise.all(
      found.assetIds.map((assetId) => assetRepository.findForWorkspace({ workspaceId, assetId })),
    )
  ).filter((asset): asset is NonNullable<typeof asset> => asset !== null && asset !== undefined);
  if (assets.length !== found.assetIds.length) return { ok: false, error: "INVALID_CONTENT" };
  const thumbnail = found.publishSpec?.thumbnailAssetId
    ? await assetRepository.findForWorkspace({
        workspaceId,
        assetId: found.publishSpec.thumbnailAssetId,
      })
    : null;

  // From ChatGPT the approver just previewed a draft that no submit-review route gated, so
  // re-run the channel validation create_content_variant ran, against the assets as they are now.
  const [channel, contentItem] = await Promise.all([
    channelRepository.findForWorkspace({ workspaceId, channelId: found.channelId }),
    contentRepository.findContentItemForWorkspace({
      workspaceId,
      contentItemId: found.contentItemId,
    }),
  ]);
  if (!channel || !contentItem) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const [offer, connection] = await Promise.all([
    contentItem.offerId && offerRepository
      ? offerRepository.findForWorkspace({ workspaceId, offerId: contentItem.offerId })
      : Promise.resolve(null),
    providerConnections.findForWorkspace({ workspaceId, connectionId: channel.connectionId }),
  ]);
  if ((contentItem.offerId && !offer) || !connection)
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (offer && offer.marketplace === "tiktok_shop") {
    const activeSnapshot = offer.snapshots.find(
      (snapshot) => snapshot.id === offer.activeSnapshotId,
    );
    try {
      assertTikTokShopPublishable({ channel, offer, snapshot: activeSnapshot, now: new Date() });
    } catch (error) {
      if (error instanceof Error && error.message === "shop_not_enabled")
        return { ok: false, error: "SHOP_NOT_ENABLED" };
      if (error instanceof Error && error.message === "commercial_snapshot_stale")
        return { ok: false, error: "COMMERCIAL_SNAPSHOT_STALE" };
      throw error;
    }
  }
  const review = validateVariantForReview(found, {
    channel,
    connectionStatus: connection.status,
    ...(offer ? { offer } : {}),
    assets,
    sourceFactKeys: contentItem.sourceFactKeys,
    ...(thumbnail ? { thumbnail } : {}),
  });
  if (!review.ok) {
    return {
      ok: false,
      error:
        review.code === "offer_snapshot_invalid"
          ? "OFFER_FACTS_CHANGED"
          : review.code === "offer_unexpected"
            ? "OFFER_UNEXPECTED"
            : "INVALID_CONTENT",
    };
  }
  const variant = found.state === "ready_for_review" ? found : submitForReview(found);

  const policy = await publicationPolicyRepository.findForWorkspace(workspaceId);
  const destination = offer ? offerDestination(offer) : null;
  const fingerprint = publicationFingerprint({
    schemaVersion: 1,
    variantId: variant.id,
    channelId: channel.id,
    connectionId: connection.id,
    destinationFingerprint: destination ? destinationFingerprint(destination) : null,
    caption: variant.caption,
    publishSpec: variant.publishSpec ?? null,
    mediaAssetChecksums: assets.map((asset) => asset.checksum),
    thumbnailChecksum: thumbnail?.checksum ?? null,
    language: variant.language,
    voiceScript: variant.voiceScript,
  });
  if (channel.kind === "youtube") {
    const script = dependencies.editorialRepository
      ? await dependencies.editorialRepository.findScriptVersion({
          workspaceId,
          contentItemId: contentItem.id,
        })
      : null;
    if (
      !script ||
      script.status !== "approved" ||
      !script.approvedChecksum ||
      script.approvedChecksum !== script.checksum
    )
      return { ok: false, error: "SCRIPT_NOT_APPROVED" };
    const editorialReview = await dependencies.editorialRepository?.findCurrentReview({
      workspaceId,
      variantId: variant.id,
    });
    if (!editorialReview) return { ok: false, error: "EDITORIAL_REVIEW_MISSING" };
    const requiredAssets = await resolveAssetRights({
      workspaceId,
      assets: [...assets, ...(thumbnail ? [thumbnail] : [])],
      findAsset: (assetId) => assetRepository.findForWorkspace({ workspaceId, assetId }),
    });
    if (
      !isCountingEditorialReview(editorialReview, fingerprint) ||
      editorialReview.rightsFingerprint !== assetRightsFingerprint(requiredAssets)
    )
      return { ok: false, error: "EDITORIAL_REVIEW_STALE" };
    const unverified = requiredAssets.find((asset) => asset.commercialUse !== true);
    if (unverified) return { ok: false, error: `RIGHTS_UNVERIFIED:${unverified.id}` };
  }
  const decision = {
    id: randomUUID(),
    workspaceId,
    variantId: variant.id,
    actorId,
    assetChecksums: assets.map((asset) => asset.checksum),
    offerSnapshotId: variant.offerSnapshotId,
    publicationFingerprint: fingerprint,
    policyVersion: policy.version,
    decidedAt: new Date(),
  };
  const prepublish = await prepublishScoreFor({
    workspaceId,
    variant,
    item: contentItem,
    channel,
    offer,
    policy,
    reelRenders: dependencies.reelRenders,
  });
  // Every channel, not only YouTube: a stored Agnes scene clip stays unapprovable until G0.
  const unverifiedClip = await findUnverifiedGeneratedClip({
    workspaceId,
    assets: [...assets, ...(thumbnail ? [thumbnail] : [])],
    findAsset: (assetId) => assetRepository.findForWorkspace({ workspaceId, assetId }),
  });
  // Agnes terms 6.1: viewers must be told when content was generated by the service.
  const generatedClip = await findGeneratedClip({
    workspaceId,
    assets: [...assets, ...(thumbnail ? [thumbnail] : [])],
    findAsset: (assetId) => assetRepository.findForWorkspace({ workspaceId, assetId }),
  });
  const result = approveVariant(variant, decision, {
    prepublish,
    ...(unverifiedClip ? { unverifiedClipAssetId: unverifiedClip.id } : {}),
    aiDisclosureMissing: generatedClip !== undefined && !hasAiDisclosure(variant.caption),
  });
  if (!result.ok && result.code === "ai_disclosure_missing")
    return { ok: false, error: "AI_DISCLOSURE_MISSING" };
  if (!result.ok && result.code === "generated_clip_rights_unverified")
    return { ok: false, error: `RIGHTS_UNVERIFIED:${result.assetId}` };
  if (!result.ok)
    return {
      ok: false,
      error:
        result.code === "fidelity_blocked"
          ? "FIDELITY_BLOCKED"
          : result.code === "prepublish_blocked"
            ? "PREPUBLISH_BLOCKED"
            : "INVALID_CONTENT",
    };
  return {
    ok: true,
    value: {
      variant: await contentRepository.recordApproval({
        workspaceId,
        variant: result.variant,
        decision,
      }),
    },
  };
};
