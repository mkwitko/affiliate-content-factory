import type { FastifyInstance, FastifyReply } from "fastify";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createNiche } from "@money-maker/core/niches/niche";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;

const schema = z
  .object({
    name: z.string().trim().min(1).max(200),
    audience: z.string().trim().min(1).max(500),
    problem: z.string().trim().min(1).max(1_000),
    editorialVoice: z.string().trim().min(1).max(500),
    languages: z.array(z.string().trim().min(2).max(10)).min(1).max(10),
    monetizationHypothesis: z.string().trim().min(1).max(1_000),
  })
  .strict();

const parseId = (value: string) => {
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

export const registerNicheRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/v1/workspaces/:workspaceId/niches",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = parseId(request.params.workspaceId);
      const body = schema.safeParse(request.body);
      if (!workspaceId || !body.success)
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
        actorId: authentication.userId as UserId,
        workspaceId,
        membership: await options.dependencies.workspaces.findMembership({
          workspaceId,
          userId: authentication.userId,
        }),
        allowedRoles: ["owner", "operator"],
      });
      if (!authorization.ok) return authorizationError(reply, 403);
      if (!options.dependencies.nicheRepository) return unexpectedError(reply);
      try {
        const niche = createNiche({ ...body.data, workspaceId });
        return reply
          .code(201)
          .send({ niche: await options.dependencies.nicheRepository.create(niche) });
      } catch {
        return sendError(reply, 400, { code: "INVALID_NICHE", message: "Niche data is invalid" });
      }
    },
  );
};
