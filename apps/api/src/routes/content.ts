import type { FastifyInstance, FastifyReply } from "fastify";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import {
  createContentItem,
  createVariant,
  validateVariantForReview,
} from "@money-maker/core/content/content";
import { z } from "zod";
import { sendError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";
import { youtubePublishSpecV1Schema } from "../schemas/youtube-publish-spec.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type WorkspaceParams = { workspaceId: string };
type VariantParams = { workspaceId: string; contentItemId: string };

const identifier = z.string().trim().min(1).max(200);
const contentItemSchema = z
  .object({
    nicheId: identifier,
    offerId: identifier.optional(),
    title: z.string().trim().min(1).max(500),
    sourceFactKeys: z.array(z.string().trim().min(1).max(100)).max(50),
    creativeOpinion: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.offerId && value.sourceFactKeys.length)
      context.addIssue({ code: "custom", message: "sourceFactKeys require offerId" });
    if (value.offerId && value.sourceFactKeys.length === 0)
      context.addIssue({ code: "custom", message: "commerce content requires sourceFactKeys" });
  });
const variantSchema = z
  .object({
    channelId: identifier,
    offerSnapshotId: identifier.optional(),
    assetIds: z.array(identifier).max(35),
    caption: z.string().trim().min(1).max(5_000),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    publishSpec: youtubePublishSpecV1Schema.optional(),
  })
  .strict();

const workspace = (value: string) => {
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
) => {
  const member = await dependencies.workspaces.findByIdForMember({ workspaceId, userId });
  if (!member) return { ok: false as const, status: 404 as const };
  const authorization = authorizeWorkspace({
    actorId: userId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId }),
    allowedRoles: ["owner", "operator"],
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
    !dependencies.channelRepository ||
    !dependencies.assetRepository ||
    !dependencies.providerConnections ||
    !dependencies.nicheRepository
  ) {
    throw new Error("Content dependencies are not configured.");
  }
  return {
    content: dependencies.contentRepository,
    offers: dependencies.offerRepository,
    channels: dependencies.channelRepository,
    assets: dependencies.assetRepository,
    connections: dependencies.providerConnections,
    niches: dependencies.nicheRepository,
  };
};

export const registerContentRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.post<{ Params: WorkspaceParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = workspace(request.params.workspaceId);
      const body = contentItemSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content, offers, niches } = requireDependencies(options.dependencies);
        const offer =
          body.data.offerId && offers
            ? await offers.findForWorkspace({ workspaceId, offerId: body.data.offerId })
            : null;
        if (body.data.offerId && !offer) return error(reply, 404, "NOT_FOUND", "Offer not found");
        const niche = await niches.findForWorkspace({ workspaceId, nicheId: body.data.nicheId });
        if (!niche) return error(reply, 404, "NOT_FOUND", "Niche not found");
        const item = createContentItem({ ...body.data, workspaceId, ...(offer ? { offer } : {}) });
        return reply.code(201).send({ contentItem: await content.createContentItem(item) });
      } catch {
        return error(reply, 409, "INVALID_CONTENT", "Content data is invalid");
      }
    },
  );

  app.post<{ Params: VariantParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/content/:contentItemId/variants",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = workspace(request.params.workspaceId);
      const body = variantSchema.safeParse(request.body);
      if (!workspaceId || !request.params.contentItemId || !body.success) {
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { content, offers, channels, assets, connections } = requireDependencies(
          options.dependencies,
        );
        const item = await content.findContentItemForWorkspace({
          workspaceId,
          contentItemId: request.params.contentItemId,
        });
        const channel = await channels.findForWorkspace({
          workspaceId,
          channelId: body.data.channelId,
        });
        if (!item || !channel)
          return error(reply, 404, "NOT_FOUND", "Content or channel not found");
        if (channel.kind === "youtube" && !body.data.publishSpec)
          return error(reply, 400, "PUBLISH_SPEC_MISSING", "YouTube variants require publishSpec");
        if (channel.kind !== "youtube" && body.data.publishSpec)
          return error(reply, 400, "PUBLISH_SPEC_INVALID", "publishSpec is only valid for YouTube");
        const offer =
          item.offerId && offers
            ? await offers.findForWorkspace({ workspaceId, offerId: item.offerId })
            : null;
        const connection = await connections.findForWorkspace({
          workspaceId,
          connectionId: channel.connectionId,
        });
        if ((item.offerId && !offer) || !connection)
          return error(reply, 404, "NOT_FOUND", "Content dependency not found");
        if (
          body.data.offerSnapshotId !== undefined &&
          body.data.offerSnapshotId !== item.offerSnapshotId &&
          body.data.offerSnapshotId !== offer?.activeSnapshotId
        ) {
          return error(
            reply,
            409,
            "INVALID_CONTENT",
            "Offer evidence snapshot does not match content",
          );
        }
        const resolvedAssets = await Promise.all(
          body.data.assetIds.map((assetId) => assets.findForWorkspace({ workspaceId, assetId })),
        );
        if (resolvedAssets.some((asset) => asset === null)) {
          return error(reply, 404, "NOT_FOUND", "Asset not found");
        }
        const thumbnail = body.data.publishSpec?.thumbnailAssetId
          ? await assets.findForWorkspace({
              workspaceId,
              assetId: body.data.publishSpec.thumbnailAssetId,
            })
          : null;
        const variant = createVariant({
          workspaceId,
          contentItem: item,
          channel,
          ...(offer ? { offer } : {}),
          assetIds: body.data.assetIds,
          caption: body.data.caption,
          language: body.data.language,
          ...(body.data.publishSpec ? { publishSpec: body.data.publishSpec } : {}),
        });
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
          return error(reply, 409, review.code.toUpperCase(), "Variant cannot be reviewed");
        return reply.code(201).send({ variant: await content.createVariant(variant) });
      } catch {
        return error(reply, 409, "INVALID_CONTENT", "Variant data is invalid");
      }
    },
  );
};
