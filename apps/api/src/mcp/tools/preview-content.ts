import { failedChecks, prepublishScoreFor } from "../../prepublish.js";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { previewContent } from "@money-maker/core/content/preview-content";
import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import { offerDestination } from "@money-maker/core/offers/offer";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import {
  assetRightsFingerprint,
  isCountingEditorialReview,
} from "@money-maker/core/content/editorial";
import { resolveAssetRights } from "@money-maker/core/assets/asset-rights";
import {
  effectiveShopState,
  parseTikTokShopStatus,
} from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const previewContentInputSchema = z
  .object({
    workspaceId: z.uuid(),
    variantId: z.string().trim().min(1).max(200),
  })
  .strict();
export const previewContentTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = previewContentInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.contentRepository ||
    !deps.channelRepository ||
    !deps.assetRepository
  )
    return parsed.success
      ? (() => {
          throw new Error("Preview dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const variant = await deps.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (variant.creativeRender?.state === "pending") return { ok: false, error: "PENDING_RENDER" };
  if (variant.creativeRender?.state === "failed")
    return { ok: false, error: `RENDER_FAILED:${variant.creativeRender.reason ?? "unknown"}` };
  const channel = await deps.channelRepository.findForWorkspace({
    workspaceId,
    channelId: variant.channelId,
  });
  if (!channel) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const assets = (
    await Promise.all(
      variant.assetIds.map((assetId) =>
        deps.assetRepository?.findForWorkspace({ workspaceId, assetId }),
      ),
    )
  ).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
  if (assets.length !== variant.assetIds.length) return { ok: false, error: "INVALID_CONTENT" };
  const thumbnail = variant.publishSpec?.thumbnailAssetId
    ? await deps.assetRepository.findForWorkspace({
        workspaceId,
        assetId: variant.publishSpec.thumbnailAssetId,
      })
    : null;
  if (variant.publishSpec?.thumbnailAssetId && !thumbnail)
    return { ok: false, error: "THUMBNAIL_INVALID" };
  // The snapshot the variant was built from; its facts back the caption's commercial numbers.
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const offer =
    item.offerId && deps.offerRepository
      ? await deps.offerRepository.findForWorkspace({ workspaceId, offerId: item.offerId })
      : null;
  const activeSnapshot = offer?.snapshots.find(
    (snapshot) => snapshot.id === offer.activeSnapshotId,
  );
  const destination = offer ? offerDestination(offer) : null;
  if (item.offerId && (!offer || !activeSnapshot || !destination))
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  const facts = offer?.snapshots.find((snapshot) => snapshot.id === variant.offerSnapshotId)?.facts;
  // ponytail: workspace-wide fetch capped at 200 recent approved/published variants, filtered
  // to this channel client-side (listVariantsForWorkspace has no channel filter); add one if a
  // heavy multi-channel workspace ever makes this miss real recent captions.
  const recentCaptions = (
    (await deps.contentRepository.listVariantsForWorkspace?.(workspaceId, {
      states: ["approved", "published"],
      limit: 200,
    })) ?? []
  )
    .filter((candidate) => candidate.channelId === channel.id && candidate.id !== variant.id)
    .slice(0, 10)
    .map((candidate) => candidate.caption);
  let preview: ReturnType<typeof previewContent>;
  try {
    preview = previewContent({
      variant,
      channel,
      assets,
      ...(thumbnail ? { thumbnail } : {}),
      recentCaptions,
      evidence:
        offer && activeSnapshot && destination
          ? {
              kind: "commerce",
              verifiedAt: activeSnapshot.verifiedAt,
              destinationFingerprint: destinationFingerprint(destination),
              facts: facts ?? [],
            }
          : { kind: "editorial" },
    });
  } catch {
    return { ok: false, error: "INVALID_CONTENT" };
  }
  const fingerprint = publicationFingerprint({
    schemaVersion: 1,
    variantId: variant.id,
    channelId: channel.id,
    connectionId: channel.connectionId,
    destinationFingerprint: destination ? destinationFingerprint(destination) : null,
    caption: variant.caption,
    publishSpec: variant.publishSpec ?? null,
    mediaAssetChecksums: assets.map((asset) => asset.checksum),
    thumbnailChecksum: thumbnail?.checksum ?? null,
    language: variant.language,
    voiceScript: variant.voiceScript,
  });
  const approvalStatus = !variant.approval
    ? "none"
    : variant.approval.publicationFingerprint === null
      ? "legacy"
      : variant.approval.publicationFingerprint === fingerprint
        ? "current"
        : "stale";
  const script =
    (await deps.editorialRepository?.findScriptVersion({ workspaceId, contentItemId: item.id })) ??
    null;
  const editorialReview =
    (await deps.editorialRepository?.findCurrentReview({ workspaceId, variantId: variant.id })) ??
    null;
  const rightsAssets = await resolveAssetRights({
    workspaceId,
    assets: [...assets, ...(thumbnail ? [thumbnail] : [])],
    findAsset: (assetId) => deps.assetRepository!.findForWorkspace({ workspaceId, assetId }),
  });
  const rights = rightsAssets.map((asset) => ({
    assetId: asset.id,
    commercialUse: asset.commercialUse,
  }));
  const rightsFingerprint = assetRightsFingerprint(rightsAssets);
  const reviewState = !editorialReview
    ? "none"
    : isCountingEditorialReview(editorialReview, fingerprint) &&
        editorialReview.rightsFingerprint === rightsFingerprint
      ? "current"
      : "stale";
  const tiktokShop =
    offer && offer.marketplace === "tiktok_shop" && offer.externalProductId
      ? {
          externalProductId: offer.externalProductId,
          title: offer.title,
          attach: "manual" as const,
        }
      : null;
  const shopWarnings: string[] = [];
  if (tiktokShop) {
    const shopStatus = parseTikTokShopStatus(channel.context);
    if (effectiveShopState(shopStatus, new Date()) !== "shop_enabled") {
      shopWarnings.push("shop_status_not_enabled");
    }
  }
  const editorialWarnings: string[] = [];
  if (channel.kind === "youtube") {
    if (!script || script.status !== "approved") editorialWarnings.push("script_not_approved");
    if (reviewState !== "current")
      editorialWarnings.push(
        reviewState === "none" ? "editorial_review_missing" : "editorial_review_stale",
      );
    for (const asset of rightsAssets)
      if (asset.commercialUse !== true) editorialWarnings.push(`rights_unverified:${asset.id}`);
    if (script) {
      for (const [index, claim] of script.claims.entries()) {
        for (const ref of claim.evidence) {
          if (ref.kind !== "research_observation") continue;
          const evidence = await deps.researchRepository?.findObservationForWorkspace?.({
            workspaceId,
            observationId: ref.observationId,
          });
          if (evidence && evidence.expiresAt < new Date())
            editorialWarnings.push(`evidence_expired:${index}`);
        }
      }
    }
  }
  // Short-lived signed URLs so the operator sees the real slides; null when storage is unavailable.
  const slides = await Promise.all(
    assets.map(async (asset, index) => ({
      position: index + 1,
      assetId: asset.id,
      url:
        (await deps.assetStore
          ?.createDownload({ workspaceId, assetId: asset.id })
          .then((target) => target.url)
          .catch(() => null)) ?? null,
      width: asset.width,
      height: asset.height,
    })),
  );
  const thumbnailUrl = thumbnail
    ? ((await deps.assetStore
        ?.createDownload({ workspaceId, assetId: thumbnail.id })
        .then((target) => target.url)
        .catch(() => null)) ?? null)
    : null;
  const prepublishScore = await prepublishScoreFor({
    workspaceId,
    variant,
    item,
    channel,
    offer,
    policy: await deps.publicationPolicyRepository?.findForWorkspace(workspaceId),
    reelRenders: deps.reelRenders,
  });
  return {
    ok: true,
    value: {
      prepublishScore: { ...prepublishScore, checks: failedChecks(prepublishScore) },
      preview: {
        ...preview,
        warnings: [...preview.warnings, ...editorialWarnings, ...shopWarnings],
        ...(channel.kind === "youtube"
          ? {
              nextAction: editorialWarnings.length ? ("edit" as const) : preview.nextAction,
              script: script ? { version: script.version, status: script.status } : null,
              editorialReview: reviewState,
              rights,
            }
          : {}),
        ...(preview.youtube ? { youtube: { ...preview.youtube, thumbnailUrl } } : {}),
        publicationFingerprint: fingerprint,
        approvalStatus,
      },
      voiceScript: variant.voiceScript,
      slides,
      affiliateUrl: offer?.affiliateUrl ?? null,
      tiktokShop,
    },
  };
};
