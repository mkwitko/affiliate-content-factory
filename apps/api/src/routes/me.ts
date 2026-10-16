import type { FastifyInstance } from "fastify";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

export const registerMeRoutes = async (
  app: FastifyInstance,
  options: { dependencies: ApiDependencies },
): Promise<void> => {
  app.get("/v1/me/workspaces", async (request, reply) => {
    const authentication = await options.dependencies.authenticate(request);
    if (!authentication)
      return sendError(reply, 401, { code: "UNAUTHENTICATED", message: "Authentication required" });
    if (!options.dependencies.workspaces.listForMember) return unexpectedError(reply);
    try {
      const workspaces = await options.dependencies.workspaces.listForMember(authentication.userId);
      return reply.code(200).send({ workspaces });
    } catch {
      return unexpectedError(reply);
    }
  });
};
