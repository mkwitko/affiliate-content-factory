import type { FastifyInstance, FastifyReply } from "fastify";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  acceptInvitation,
  type AcceptInvitationResult,
} from "@money-maker/core/identity/accept-invitation";
import {
  createInvitation,
  type CreateInvitationResult,
} from "@money-maker/core/identity/create-invitation";
import type { InvitationRole } from "@money-maker/core/identity/invitation-repository";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

type InvitationRouteOptions = Readonly<{
  dependencies: ApiDependencies;
}>;

type CreateInvitationRoute = {
  Params: { workspaceId: string };
  Body: unknown;
};

type AcceptInvitationRoute = {
  Params: { token: string };
  Body: unknown;
};

const createInvitationSchema = z
  .object({
    email: z.email(),
    role: z.enum(["operator", "reviewer"]),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const acceptInvitationSchema = z.object({ email: z.email() }).strict();

const validationError = (reply: FastifyReply): FastifyReply =>
  sendError(reply, 400, {
    code: "INVALID_REQUEST",
    message: "Request validation failed",
  });

const createErrorStatus = (
  code: Extract<CreateInvitationResult, { ok: false }>["error"]["code"],
): number => {
  if (code === "FORBIDDEN") return 403;
  return 400;
};

const acceptErrorStatus = (
  code: Extract<AcceptInvitationResult, { ok: false }>["error"]["code"],
): number => {
  switch (code) {
    case "INVITATION_EXPIRED":
    case "INVITATION_REVOKED":
      return 410;
    case "INVITATION_ALREADY_USED":
      return 409;
    case "INVITATION_EMAIL_MISMATCH":
      return 403;
    case "INVITATION_NOT_FOUND":
      return 404;
  }
};

export const registerInvitationRoutes = async (
  app: FastifyInstance,
  options: InvitationRouteOptions,
): Promise<void> => {
  app.post<CreateInvitationRoute>(
    "/v1/workspaces/:workspaceId/invitations",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication) {
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }

      const body = createInvitationSchema.safeParse(request.body);
      if (!body.success) return validationError(reply);

      let targetWorkspaceId: ReturnType<typeof parseWorkspaceId>;
      try {
        targetWorkspaceId = parseWorkspaceId(request.params.workspaceId);
      } catch {
        return validationError(reply);
      }

      try {
        const result = await createInvitation(
          {
            actorId: authentication.userId,
            workspaceId: targetWorkspaceId,
            email: body.data.email,
            role: body.data.role as InvitationRole,
            expiresAt: new Date(body.data.expiresAt),
          },
          options.dependencies.invitation,
        );

        if (!result.ok) {
          return sendError(reply, createErrorStatus(result.error.code), result.error);
        }

        return reply.code(201).send({ invitation: result.invitation, token: result.token });
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.post<AcceptInvitationRoute>("/v1/invitations/:token/accept", async (request, reply) => {
    const authentication = await options.dependencies.authenticate(request);
    if (!authentication) {
      return sendError(reply, 401, {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }

    const body = acceptInvitationSchema.safeParse(request.body);
    if (!body.success || !request.params.token) return validationError(reply);

    try {
      const result = await acceptInvitation(
        {
          userId: authentication.userId,
          email: authentication.verifiedEmail,
          token: request.params.token,
        },
        options.dependencies.invitation,
      );

      if (!result.ok) {
        return sendError(reply, acceptErrorStatus(result.error.code), result.error);
      }

      return reply.code(200).send({ invitationId: result.invitationId, status: result.status });
    } catch {
      return unexpectedError(reply);
    }
  });
};
