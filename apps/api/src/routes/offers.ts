import type { FastifyInstance, FastifyReply } from "fastify";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createOfferForWorkspace } from "@money-maker/core/offers/create-offer";
import {
  activateOfferForWorkspace,
  addOfferEvidence,
  rejectOfferForWorkspace,
} from "@money-maker/core/offers/review-offer";
import type { CommercialSnapshot, Offer } from "@money-maker/core/offers/offer";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type WorkspaceParams = { workspaceId: string };
type OfferParams = { workspaceId: string; offerId: string };

const moneySchema = z
  .object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();
const createSchema = z
  .object({
    listingUrl: z.url(),
    affiliateUrl: z.url().optional(),
    title: z.string().trim().min(1).max(500),
    listPrice: moneySchema.optional(),
    currentPrice: moneySchema.optional(),
    discount: moneySchema.optional(),
    shipping: moneySchema.optional(),
    commission: moneySchema.optional(),
    fees: moneySchema.optional(),
    revenue: moneySchema.optional(),
  })
  .strict();
const factSchema = z
  .object({
    key: z.string().trim().min(1).max(100),
    value: z.union([z.string(), z.number().finite(), z.boolean(), moneySchema]),
    sourceUrl: z.url(),
    verified: z.boolean(),
  })
  .strict();
const snapshotSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    verifiedAt: z.iso.datetime({ offset: true }),
    facts: z.array(factSchema).min(1).max(50),
  })
  .strict();
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const parseId = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const error = (reply: FastifyReply, status: number, code: string, message: string) =>
  sendError(reply, status, { code, message });

const requireOfferDependencies = (dependencies: ApiDependencies) => {
  if (!dependencies.offerRepository || !dependencies.audit) {
    throw new Error("Offer dependencies are not configured.");
  }
  return { offers: dependencies.offerRepository, audit: dependencies.audit };
};

const authorizeMember = async (
  dependencies: ApiDependencies,
  workspaceId: ReturnType<typeof parseWorkspaceId>,
  userId: UserId,
  allowedRoles: readonly ("owner" | "operator" | "reviewer")[],
) => {
  const workspace = await dependencies.workspaces.findByIdForMember({ workspaceId, userId });
  if (!workspace) return { ok: false as const, status: 404 as const };
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

const publicOffer = (offer: Offer): Offer => offer;

export const registerOfferRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.post<{ Params: WorkspaceParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/offers",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      const body = createSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const offer = await createOfferForWorkspace(
          {
            workspaceId,
            marketplace: "mercado_livre",
            listingUrl: body.data.listingUrl,
            title: body.data.title,
            actorUserId: authentication.userId,
            ...(body.data.affiliateUrl ? { affiliateUrl: body.data.affiliateUrl } : {}),
            ...(body.data.listPrice ? { listPrice: body.data.listPrice } : {}),
            ...(body.data.currentPrice ? { currentPrice: body.data.currentPrice } : {}),
            ...(body.data.discount ? { discount: body.data.discount } : {}),
            ...(body.data.shipping ? { shipping: body.data.shipping } : {}),
            ...(body.data.commission ? { commission: body.data.commission } : {}),
            ...(body.data.fees ? { fees: body.data.fees } : {}),
            ...(body.data.revenue ? { revenue: body.data.revenue } : {}),
          },
          requireOfferDependencies(options.dependencies),
        );
        return reply.code(201).send({ offer: publicOffer(offer) });
      } catch {
        return error(reply, 400, "INVALID_OFFER", "Offer data is invalid");
      }
    },
  );

  app.get<{ Params: OfferParams }>(
    "/v1/workspaces/:workspaceId/offers/:offerId",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      if (!workspaceId || !request.params.offerId)
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const { offers } = requireOfferDependencies(options.dependencies);
        const offer = await offers.findForWorkspace({
          workspaceId,
          offerId: request.params.offerId,
        });
        return offer
          ? reply.code(200).send({ offer: publicOffer(offer) })
          : error(reply, 404, "NOT_FOUND", "Offer not found");
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: OfferParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/offers/:offerId/evidence",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      const body = snapshotSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const offer = await addOfferEvidence(
          {
            workspaceId,
            offerId: request.params.offerId,
            actorUserId: authentication.userId,
            snapshot: body.data as unknown as CommercialSnapshot,
          },
          requireOfferDependencies(options.dependencies),
        );
        return offer
          ? reply.code(201).send({ offer: publicOffer(offer) })
          : error(reply, 404, "NOT_FOUND", "Offer not found");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Offer evidence is invalid";
        return error(reply, 409, "INVALID_EVIDENCE", message);
      }
    },
  );

  app.post<{ Params: OfferParams }>(
    "/v1/workspaces/:workspaceId/offers/:offerId/activate",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      if (!workspaceId) return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const offer = await activateOfferForWorkspace(
          { workspaceId, offerId: request.params.offerId, actorUserId: authentication.userId },
          requireOfferDependencies(options.dependencies),
        );
        return offer
          ? reply.code(200).send({ offer: publicOffer(offer) })
          : error(reply, 404, "NOT_FOUND", "Offer not found");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Offer cannot be activated";
        return error(reply, 409, "OFFER_NOT_READY", message);
      }
    },
  );

  app.post<{ Params: OfferParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/offers/:offerId/reject",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) return error(reply, 401, "UNAUTHENTICATED", "Authentication required");
      const workspaceId = parseId(request.params.workspaceId);
      const body = rejectSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return error(reply, 400, "INVALID_REQUEST", "Request validation failed");
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok) return authorizationError(reply, authorization);
      try {
        const offer = await rejectOfferForWorkspace(
          {
            workspaceId,
            offerId: request.params.offerId,
            actorUserId: authentication.userId,
            reason: body.data.reason,
          },
          requireOfferDependencies(options.dependencies),
        );
        return offer
          ? reply.code(200).send({ offer: publicOffer(offer) })
          : error(reply, 404, "NOT_FOUND", "Offer not found");
      } catch {
        return error(reply, 400, "INVALID_OFFER", "Offer data is invalid");
      }
    },
  );
};
