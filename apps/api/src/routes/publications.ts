import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseWorkspaceId } from "@money-maker/contracts";
import { isPublishableChannelKind } from "@money-maker/core/channels/channel";
import { requestPublication } from "@money-maker/core/publishing/request-publication";
import { publicationFingerprint } from "@money-maker/core/content/publication-fingerprint";
import { destinationFingerprint } from "@money-maker/core/analytics/attribution";
import { offerDestination } from "@money-maker/core/offers/offer";
import {
  assetRightsFingerprint,
  isCountingEditorialReview,
} from "@money-maker/core/content/editorial";
import { resolveAssetRights } from "@money-maker/core/assets/asset-rights";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";
import { authorizeMember } from "./provider-connections.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type WorkspaceParams = { workspaceId: string };
type PublicationParams = { workspaceId: string; attemptId: string };

const requestSchema = z
  .object({
    contentVariantId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

const workspace = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const requirePublicationDependencies = (dependencies: ApiDependencies) => {
  if (
    !dependencies.contentRepository ||
    !dependencies.channelRepository ||
    !dependencies.providerConnections ||
    !dependencies.publicationAttempts ||
    !dependencies.jobQueue
  ) {
    throw new Error("Publication dependencies are not configured.");
  }
  return {
    content: dependencies.contentRepository,
    channels: dependencies.channelRepository,
    connections: dependencies.providerConnections,
    attempts: dependencies.publicationAttempts,
    queue: dependencies.jobQueue,
  };
};

const publicAttempt = (
  attempt: Awaited<
    ReturnType<NonNullable<ApiDependencies["publicationAttempts"]>["findForWorkspace"]>
  >,
) => attempt;

export const registerPublicationRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.post<{ Params: WorkspaceParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/publications",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      const body = requestSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      try {
        const dependencies = requirePublicationDependencies(options.dependencies);
        const variant = await dependencies.content.findVariantForWorkspace({
          workspaceId,
          variantId: body.data.contentVariantId,
        });
        if (!variant)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Content variant not found" });
        const item = await dependencies.content.findContentItemForWorkspace({
          workspaceId,
          contentItemId: variant.contentItemId,
        });
        if (!item)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Content item not found" });
        const channel = await dependencies.channels.findForWorkspace({
          workspaceId,
          channelId: variant.channelId,
        });
        if (!channel)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Channel not found" });
        if (channel.kind === "youtube" && !variant.publishSpec)
          return sendError(reply, 409, {
            code: "PUBLISH_SPEC_MISSING",
            message: "YouTube publishSpec is required",
          });
        if (item.offerId === null && channel.kind !== "youtube")
          return sendError(reply, 409, {
            code: "EDITORIAL_PUBLICATION_NOT_ENABLED",
            message: "Editorial publication is enabled only for reviewed YouTube variants",
          });
        if (!isPublishableChannelKind(channel.kind))
          return sendError(reply, 409, {
            code: "CHANNEL_UNSUPPORTED",
            message: "This channel cannot be published yet",
          });
        const connection = await dependencies.connections.findForWorkspace({
          workspaceId,
          connectionId: channel.connectionId,
        });
        if (!connection)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Connection not found" });
        if (variant.approval?.publicationFingerprint) {
          const [offer, assets, thumbnail] = await Promise.all([
            item.offerId && options.dependencies.offerRepository
              ? options.dependencies.offerRepository.findForWorkspace({
                  workspaceId,
                  offerId: item.offerId,
                })
              : Promise.resolve(null),
            options.dependencies.assetRepository
              ? Promise.all(
                  variant.assetIds.map((assetId) =>
                    options.dependencies.assetRepository?.findForWorkspace({
                      workspaceId,
                      assetId,
                    }),
                  ),
                )
              : Promise.resolve([]),
            variant.publishSpec?.thumbnailAssetId && options.dependencies.assetRepository
              ? options.dependencies.assetRepository.findForWorkspace({
                  workspaceId,
                  assetId: variant.publishSpec.thumbnailAssetId,
                })
              : Promise.resolve(null),
          ]);
          if (
            (item.offerId && !offer) ||
            assets.length !== variant.assetIds.length ||
            assets.some((asset) => !asset)
          )
            return sendError(reply, 409, {
              code: "APPROVAL_STALE",
              message: "Preview and approve the current publication payload again",
            });
          if (variant.publishSpec?.thumbnailAssetId && !thumbnail)
            return sendError(reply, 409, {
              code: "THUMBNAIL_INVALID",
              message: "The approved thumbnail is no longer available",
            });
          const destination = offer ? offerDestination(offer) : null;
          const currentFingerprint = publicationFingerprint({
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
          if (currentFingerprint !== variant.approval.publicationFingerprint)
            return sendError(reply, 409, {
              code: "APPROVAL_STALE",
              message: "Preview and approve the current publication payload again",
            });
          if (channel.kind === "youtube") {
            const review = await options.dependencies.editorialRepository?.findCurrentReview({
              workspaceId,
              variantId: variant.id,
            });
            const rightsAssets = await resolveAssetRights({
              workspaceId,
              assets: [
                ...assets.filter((asset) => asset !== null && asset !== undefined),
                ...(thumbnail ? [thumbnail] : []),
              ],
              findAsset: (assetId) =>
                options.dependencies.assetRepository!.findForWorkspace({ workspaceId, assetId }),
            });
            if (
              !review ||
              !isCountingEditorialReview(review, currentFingerprint) ||
              review.rightsFingerprint !== assetRightsFingerprint(rightsAssets) ||
              rightsAssets.some((asset) => asset.commercialUse !== true)
            )
              return sendError(reply, 409, {
                code: "EDITORIAL_REVIEW_STALE",
                message: "Record a current editorial review after verifying asset rights",
              });
          }
        }
        if (channel.kind === "youtube" && !variant.approval?.publicationFingerprint)
          return sendError(reply, 409, {
            code: "APPROVAL_STALE",
            message: "Approve this YouTube publication fingerprint first",
          });
        const result = await requestPublication({
          workspaceId,
          variant,
          channel,
          connection,
          ...dependencies,
          attemptId: randomUUID(),
          idempotencyKey: body.data.idempotencyKey,
          requestFingerprint: createHash("sha256").update(JSON.stringify(body.data)).digest("hex"),
          correlationId: randomUUID(),
        });
        return reply
          .code(result.created ? 202 : 200)
          .send({ publication: publicAttempt(result.attempt) });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "content_not_approved")
          return sendError(reply, 409, {
            code: "CONTENT_NOT_APPROVED",
            message: "Content must be approved before publication",
          });
        if (error instanceof Error && error.message === "provider_connection_unavailable")
          return sendError(reply, 409, {
            code: "CONNECTION_UNAVAILABLE",
            message: "Provider connection is unavailable",
          });
        return unexpectedError(reply);
      }
    },
  );

  app.get<{ Params: PublicationParams }>(
    "/v1/workspaces/:workspaceId/publications/:attemptId",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (!workspaceId || !request.params.attemptId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (!options.dependencies.publicationAttempts) return unexpectedError(reply);
      const attempt = await options.dependencies.publicationAttempts.findForWorkspace({
        workspaceId,
        attemptId: request.params.attemptId,
      });
      return attempt
        ? reply.code(200).send({ publication: publicAttempt(attempt) })
        : sendError(reply, 404, { code: "NOT_FOUND", message: "Publication not found" });
    },
  );

  app.post<{ Params: PublicationParams }>(
    "/v1/workspaces/:workspaceId/publications/:attemptId/reconcile",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (
        !workspaceId ||
        !options.dependencies.publicationAttempts ||
        !options.dependencies.providerConnections ||
        !options.dependencies.socialPublisherForWorkspace
      )
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const attempt = await options.dependencies.publicationAttempts.findForWorkspace({
        workspaceId,
        attemptId: request.params.attemptId,
      });
      if (!attempt)
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Publication not found" });
      if (attempt.status !== "unknown_outcome")
        return sendError(reply, 409, {
          code: "PUBLICATION_NOT_RECONCILABLE",
          message: "Only unknown publications can be reconciled",
        });
      const connection = await options.dependencies.providerConnections.findForWorkspace({
        workspaceId,
        connectionId: attempt.connectionId,
      });
      if (connection?.status !== "active")
        return sendError(reply, 409, {
          code: "CONNECTION_UNAVAILABLE",
          message: "Provider connection is unavailable",
        });
      try {
        const result = await options.dependencies
          .socialPublisherForWorkspace(workspaceId)
          .reconcile({
            secretReference: connection.secretReference,
            accountId: connection.accountId,
            externalId: attempt.attemptId,
          });
        if (result.status === "published") {
          await options.dependencies.publicationAttempts.recordPublished({
            workspaceId,
            attemptId: attempt.attemptId,
            externalId: result.externalId,
          });
        } else if (result.status === "failed") {
          await options.dependencies.publicationAttempts.recordFailure({
            workspaceId,
            attemptId: attempt.attemptId,
            status: "permanent_failure",
            reason: `provider_post_failed: ${result.failureReason ?? "provider_post_failed"}`,
          });
        }
        return reply.code(result.status === "queued" ? 202 : 200).send({
          publication: await options.dependencies.publicationAttempts.findForWorkspace({
            workspaceId,
            attemptId: attempt.attemptId,
          }),
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "provider_unknown_outcome")
          return sendError(reply, 409, {
            code: "PUBLICATION_STILL_UNKNOWN",
            message: "The provider has not returned a unique result",
          });
        return unexpectedError(reply);
      }
    },
  );
};
