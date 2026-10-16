import type { FastifyInstance, FastifyReply } from "fastify";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ApiDependencies } from "../app.js";
import { sendError, unexpectedError } from "../http/errors.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;

const parseId = (value: string): WorkspaceId | null => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const authorizationError = (reply: FastifyReply, status: 404 | 403) =>
  status === 404
    ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
    : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });

const publicOffer = (offer: Offer) => ({
  id: offer.id,
  title: offer.title,
  state: offer.state,
  affiliateUrl: offer.affiliateUrl ?? null,
  currentPrice: offer.currentPrice ?? null,
  activeSnapshotId: offer.activeSnapshotId ?? null,
  snapshots: offer.snapshots.map((snapshot) => ({
    id: snapshot.id,
    verifiedAt: snapshot.verifiedAt.toISOString(),
    facts: snapshot.facts.map((fact) => ({ key: fact.key, verified: fact.verified })),
  })),
});

const requireDependencies = (dependencies: ApiDependencies) => {
  if (
    !dependencies.nicheRepository?.listForWorkspace ||
    !dependencies.offerRepository?.listForWorkspace ||
    !dependencies.channelRepository?.listForWorkspace ||
    !dependencies.assetRepository?.listForWorkspace ||
    !dependencies.contentRepository?.listContentItemsForWorkspace ||
    !dependencies.contentRepository?.listVariantsForWorkspace ||
    !dependencies.providerConnections
  ) {
    throw new Error("Operator workspace dependencies are not configured.");
  }
  return {
    niches: dependencies.nicheRepository.listForWorkspace.bind(dependencies.nicheRepository),
    offers: dependencies.offerRepository.listForWorkspace.bind(dependencies.offerRepository),
    channels: dependencies.channelRepository.listForWorkspace.bind(dependencies.channelRepository),
    assets: dependencies.assetRepository.listForWorkspace.bind(dependencies.assetRepository),
    contentItems: dependencies.contentRepository.listContentItemsForWorkspace.bind(
      dependencies.contentRepository,
    ),
    variants: dependencies.contentRepository.listVariantsForWorkspace.bind(
      dependencies.contentRepository,
    ),
    connections: dependencies.providerConnections,
  };
};

export const registerOperatorWorkspaceRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/operator-context",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = parseId(request.params.workspaceId);
      if (!workspaceId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const workspace = await options.dependencies.workspaces.findByIdForMember({
        workspaceId,
        userId: authentication.userId,
      });
      if (!workspace) return authorizationError(reply, 404);
      const authorization = authorizeWorkspace({
        actorId: authentication.userId,
        workspaceId,
        membership: await options.dependencies.workspaces.findMembership({
          workspaceId,
          userId: authentication.userId,
        }),
        allowedRoles: ["owner", "operator", "reviewer"],
      });
      if (!authorization.ok) return authorizationError(reply, 403);
      try {
        const dependencies = requireDependencies(options.dependencies);
        const [niches, offers, channels, assets, contentItems, variants, connections] =
          await Promise.all([
            dependencies.niches(workspaceId),
            dependencies.offers(workspaceId),
            dependencies.channels(workspaceId),
            dependencies.assets(workspaceId),
            dependencies.contentItems(workspaceId),
            dependencies.variants(workspaceId),
            dependencies.connections.findAllForWorkspace({ workspaceId }),
          ]);
        return reply.code(200).send({
          niches: niches.map(({ id, name, state, languages }) => ({ id, name, state, languages })),
          offers: offers.filter((offer) => offer.state === "active").map(publicOffer),
          channels: channels.map(({ id, kind, label, status, capabilities }) => ({
            id,
            kind,
            label,
            status,
            capabilities,
          })),
          assets: assets.map(({ id, checksum, mimeType, width, height, state }) => ({
            id,
            checksum,
            mimeType,
            width,
            height,
            state,
          })),
          contentItems: contentItems.map(
            ({ id, title, nicheId, offerId, offerSnapshotId, state }) => ({
              id,
              title,
              nicheId,
              offerId,
              offerSnapshotId,
              state,
            }),
          ),
          variants: variants.map(
            ({
              id,
              contentItemId,
              channelId,
              offerSnapshotId,
              assetIds,
              caption,
              language,
              state,
            }) => ({
              id,
              contentItemId,
              channelId,
              offerSnapshotId,
              assetIds,
              caption,
              language,
              state,
            }),
          ),
          connections: connections.map(({ id, provider, mode, status, accountId }) => ({
            id,
            provider,
            mode,
            status,
            accountId,
          })),
        });
      } catch {
        return unexpectedError(reply);
      }
    },
  );
};
