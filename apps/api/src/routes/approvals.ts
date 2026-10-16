import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import {
  findGeneratedClip,
  findUnverifiedGeneratedClip,
  hasAiDisclosure,
} from "@money-maker/core/assets/asset-rights";
import {
  approveVariant,
  REVIEW_REASONS,
  rejectionText,
  rejectVariant,
  submitForReview,
} from "@money-maker/core/content/approval";
import { validateVariantForReview } from "@money-maker/core/content/content";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import { rejectOfferScene } from "@money-maker/core/creatives/reject-scene";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { offerDestination } from "@money-maker/core/offers/offer";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ApiDependencies } from "../app.js";
import { sendError } from "../http/errors.js";
import { prepublishScoreFor } from "../prepublish.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type VariantParams = { workspaceId: string; variantId: string };
const emptySchema = z.object({}).strict();
const rejectSchema = z
  .object({
    reason: z.string().trim().max(1_000).default(""),
    reasons: z.array(z.enum(REVIEW_REASONS)).max(5).optional(),
  })
  .strict()
  .refine((value) => value.reason.length > 0 || (value.reasons?.length ?? 0) > 0);

const rejectSceneSchema = z
  .object({
    slideIndex: z.number().int().min(1).max(10),
    canvas: z.enum(["feed", "story"]),
    reasons: z.array(z.enum(REVIEW_REASONS)).max(5).default([]),
    note: z.string().trim().max(500).default(""),
  })
  .strict()
  .refine((value) => value.reasons.length > 0 || value.note.length > 0);
const SCENE_REJECT_STATUS = {
  not_found: [404, "NOT_FOUND"],
  no_scene: [409, "NO_SCENE"],
  variant_locked: [409, "INVALID_VARIANT_STATE"],
  attempt_budget_spent: [409, "SCENE_ATTEMPTS_SPENT"],
} as const;

const parseId = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const error = (reply: FastifyReply, status: number, code: string, message: string) =>
  sendError(reply, status, { code, message });

const authorizeMember = async (
  dependencies: ApiDependencies,
  workspaceId: ReturnType<typeof parseWorkspaceId>,
  userId: UserId,
  allowedRoles: readonly ("owner" | "operator" | "reviewer")[],
) => {
  const member = await dependencies.workspaces.findByIdForMember({ workspaceId, userId });
  if (!member) return { ok: false as const, status: 404 as const };
  const authorization = authorizeWorkspace({
    actorId: userId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId }),
    allowedRoles,
  });
  return authorization.ok ? { ok: true as const } : { ok: false as const, status: 403 as const };
};

const authorizationError = (reply: FastifyReply, result: { status: 404 | 403 }) =>
  result.status === 404
    ? error(reply, 404, "NOT_FOUND", "Workspace not found")
    : error(reply, 403, "FORBIDDEN", "Access denied");

const requireDependencies = (dependencies: ApiDependencies) => {
  if (
    !dependencies.contentRepository ||
    !dependencies.assetRepository ||
    !dependencies.publicationPolicyRepository ||
    !dependencies.channelRepository ||
    !dependencies.providerConnections
  ) {
    throw new Error("Approval dependencies are not configured.");
  }
  return {
    content: dependencies.contentRepository,
    assets: dependencies.assetRepository,
    policies: dependencies.publicationPolicyRepository,
    channels: dependencies.channelRepository,
    connections: dependencies.providerConnections,
  };
};

const requireReviewQueueDependencies = (dependencies: ApiDependencies) => {
  const base = requireDependencies(dependencies);
  if (!dependencies.channelRepository) {
    throw new Error("Approval review queue dependencies are not configured.");
  }
  return {
    ...base,
    offers: dependencies.offerRepository,
    channels: dependencies.channelRepository,
  };
};

export const registerApprovalRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/content/review-queue",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      if (!workspaceId) return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content, assets, policies, offers, channels } = requireReviewQueueDependencies(
          options.dependencies,
        );
        const variants = await content.findReviewableForWorkspace(workspaceId);
        const enriched = await Promise.all(
          variants.map(async (variant) => {
            const item = await content.findContentItemForWorkspace({
              workspaceId,
              contentItemId: variant.contentItemId,
            });
            if (!item) return null;
            const offer =
              item.offerId && offers
                ? await offers.findForWorkspace({ workspaceId, offerId: item.offerId })
                : null;
            const snapshot = offer?.snapshots.find(({ id }) => id === variant.offerSnapshotId);
            const channel = await channels.findForWorkspace({
              workspaceId,
              channelId: variant.channelId,
            });
            if ((item.offerId && (!offer || !offerDestination(offer) || !snapshot)) || !channel)
              return null;
            const resolvedAssets = await Promise.all(
              variant.assetIds.map((assetId) => assets.findForWorkspace({ workspaceId, assetId })),
            );
            if (resolvedAssets.some((asset) => asset === null)) return null;
            const policy = await policies.findForWorkspace(workspaceId);
            return {
              id: variant.id,
              caption: variant.caption,
              assetChecksums: resolvedAssets.map((asset) => asset?.checksum ?? ""),
              offerSnapshotId: variant.offerSnapshotId,
              evidenceVerifiedAt: snapshot?.verifiedAt.toISOString() ?? null,
              affiliateUrl: offer?.affiliateUrl ?? null,
              ...(item.offerId ? {} : { label: "Editorial" }),
              policyMode: policy.mode,
              channelLabel: channel.label,
              channelKind: channel.kind,
              state: variant.state,
            };
          }),
        );
        return reply.code(200).send({
          variants: enriched.filter(
            (variant): variant is NonNullable<typeof variant> => variant !== null,
          ),
        });
      } catch {
        return error(reply, 500, "INTERNAL_ERROR", "An unexpected error occurred");
      }
    },
  );

  app.post<{ Params: VariantParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content/variants/:variantId/submit-review",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      if (
        !workspaceId ||
        !request.params.variantId ||
        !emptySchema.safeParse(request.body ?? {}).success
      ) {
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content } = requireDependencies(options.dependencies);
        const variant = await content.findVariantForWorkspace({
          workspaceId,
          variantId: request.params.variantId,
        });
        if (!variant) return error(reply, 404, "NOT_FOUND", "Variant not found");
        const submitted = submitForReview(variant);
        return reply.code(200).send({ variant: await content.updateVariant(submitted) });
      } catch {
        return error(reply, 409, "INVALID_VARIANT_STATE", "Variant cannot be submitted for review");
      }
    },
  );

  app.post<{ Params: VariantParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content/variants/:variantId/approve",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      if (
        !workspaceId ||
        !request.params.variantId ||
        !emptySchema.safeParse(request.body ?? {}).success
      ) {
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content, assets, policies, channels, connections } = requireDependencies(
          options.dependencies,
        );
        const variant = await content.findVariantForWorkspace({
          workspaceId,
          variantId: request.params.variantId,
        });
        if (!variant) return error(reply, 404, "NOT_FOUND", "Variant not found");
        const resolvedAssets = await Promise.all(
          variant.assetIds.map((assetId) => assets.findForWorkspace({ workspaceId, assetId })),
        );
        if (resolvedAssets.some((asset) => asset === null)) {
          return error(reply, 409, "VARIANT_CHANGED", "Variant assets are no longer available");
        }
        const thumbnail = variant.publishSpec?.thumbnailAssetId
          ? await assets.findForWorkspace({
              workspaceId,
              assetId: variant.publishSpec.thumbnailAssetId,
            })
          : null;
        const policy = await policies.findForWorkspace(workspaceId);
        const [item, channel] = await Promise.all([
          content.findContentItemForWorkspace({
            workspaceId,
            contentItemId: variant.contentItemId,
          }),
          channels.findForWorkspace({ workspaceId, channelId: variant.channelId }),
        ]);
        if (!item || !channel)
          return error(reply, 404, "NOT_FOUND", "Content item or channel not found");
        const [offer, connection] = await Promise.all([
          item.offerId && options.dependencies.offerRepository
            ? options.dependencies.offerRepository.findForWorkspace({
                workspaceId,
                offerId: item.offerId,
              })
            : Promise.resolve(null),
          connections.findForWorkspace({ workspaceId, connectionId: channel.connectionId }),
        ]);
        if ((item.offerId && !offer) || !connection)
          return error(reply, 404, "NOT_FOUND", "Approval dependency not found");
        const review = validateVariantForReview(variant, {
          channel,
          connectionStatus: connection.status,
          ...(offer ? { offer } : {}),
          assets: resolvedAssets.filter(
            (asset): asset is NonNullable<typeof asset> => asset !== null,
          ),
          sourceFactKeys: item.sourceFactKeys,
          ...(thumbnail ? { thumbnail } : {}),
        });
        if (!review.ok)
          return error(reply, 409, review.code.toUpperCase(), "Variant cannot be approved");
        const destination = offer ? offerDestination(offer) : null;
        const fingerprint = publicationFingerprint({
          schemaVersion: 1,
          variantId: variant.id,
          channelId: channel.id,
          connectionId: connection.id,
          destinationFingerprint: destination ? destinationFingerprint(destination) : null,
          caption: variant.caption,
          publishSpec: variant.publishSpec ?? null,
          mediaAssetChecksums: resolvedAssets.map((asset) => asset?.checksum ?? ""),
          thumbnailChecksum: thumbnail?.checksum ?? null,
          language: variant.language,
          voiceScript: variant.voiceScript,
        });
        const decision = {
          id: randomUUID(),
          workspaceId,
          variantId: variant.id,
          actorId: authentication.userId,
          assetChecksums: resolvedAssets.map((asset) => asset?.checksum ?? ""),
          offerSnapshotId: variant.offerSnapshotId,
          publicationFingerprint: fingerprint,
          policyVersion: policy.version,
          decidedAt: new Date(),
        };
        const prepublish = await prepublishScoreFor({
          workspaceId,
          variant,
          item,
          channel,
          offer,
          policy,
          reelRenders: options.dependencies.reelRenders,
        });
        // Every channel, not only YouTube: a stored Agnes scene clip stays unapprovable until G0.
        const unverifiedClip = await findUnverifiedGeneratedClip({
          workspaceId,
          assets: [
            ...resolvedAssets.filter((asset): asset is NonNullable<typeof asset> => asset !== null),
            ...(thumbnail ? [thumbnail] : []),
          ],
          findAsset: (assetId) => assets.findForWorkspace({ workspaceId, assetId }),
        });
        // Agnes terms 6.1: viewers must be told when content was generated by the service.
        const generatedClip = await findGeneratedClip({
          workspaceId,
          assets: [
            ...resolvedAssets.filter((asset): asset is NonNullable<typeof asset> => asset !== null),
            ...(thumbnail ? [thumbnail] : []),
          ],
          findAsset: (assetId) => assets.findForWorkspace({ workspaceId, assetId }),
        });
        // The panel approves a rendered draft in one click, like the MCP tool: submit, then approve.
        const reviewable =
          variant.state === "ready_for_review" ? variant : submitForReview(variant);
        const result = approveVariant(reviewable, decision, {
          prepublish,
          ...(unverifiedClip ? { unverifiedClipAssetId: unverifiedClip.id } : {}),
          aiDisclosureMissing: generatedClip !== undefined && !hasAiDisclosure(variant.caption),
        });
        if (!result.ok)
          return error(reply, 409, result.code.toUpperCase(), "Variant cannot be approved");
        return reply.code(200).send({
          variant: await content.recordApproval({
            workspaceId,
            variant: result.variant,
            decision,
          }),
        });
      } catch {
        return error(reply, 409, "INVALID_VARIANT_STATE", "Variant cannot be approved");
      }
    },
  );

  app.post<{ Params: VariantParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content/variants/:variantId/reject",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      const body = rejectSchema.safeParse(request.body);
      if (!workspaceId || !request.params.variantId || !body.success) {
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content } = requireDependencies(options.dependencies);
        const variant = await content.findVariantForWorkspace({
          workspaceId,
          variantId: request.params.variantId,
        });
        if (!variant) return error(reply, 404, "NOT_FOUND", "Variant not found");
        return reply.code(200).send({
          variant: await content.updateVariant(
            rejectVariant(
              variant.state === "ready_for_review" ? variant : submitForReview(variant),
              rejectionText(body.data.reasons ?? [], body.data.reason),
            ),
          ),
        });
      } catch {
        return error(reply, 409, "INVALID_VARIANT_STATE", "Variant cannot be rejected");
      }
    },
  );

  // Review Studio: reject one scene of an auto package; only that slot is redrawn.
  app.post<{ Params: { workspaceId: string; contentItemId: string }; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content/items/:contentItemId/scenes/reject",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      const body = rejectSceneSchema.safeParse(request.body);
      if (!workspaceId || !request.params.contentItemId || !body.success) {
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      const {
        contentRepository: content,
        assetRepository: assets,
        jobQueue: jobs,
      } = options.dependencies;
      if (!content || !assets?.updateMetadata || !assets.listByMetadata || !jobs)
        return error(reply, 503, "UNAVAILABLE", "Scene review is not configured");
      // The repository itself, never a spread: its methods live on the class prototype.
      const result = await rejectOfferScene(
        {
          content,
          assets: assets as Parameters<typeof rejectOfferScene>[0]["assets"],
          jobs,
          ...(options.dependencies.reelRenders ? { reels: options.dependencies.reelRenders } : {}),
          now: () => new Date(),
        },
        {
          workspaceId,
          contentItemId: request.params.contentItemId,
          ...body.data,
          actorId: authentication.userId,
        },
      );
      if (!result.ok) {
        const [status, code] = SCENE_REJECT_STATUS[result.code];
        return error(reply, status, code, "Scene cannot be rejected");
      }
      return reply.code(202).send(result);
    },
  );
};
