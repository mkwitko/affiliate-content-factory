import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDependencies } from "../app.js";
import { sendError, unexpectedError } from "../http/errors.js";
import { listFailedJobsTool, retryFailedJobTool } from "../mcp/tools/retry-failed-job.js";
import type { ToolResult } from "../mcp/tool-result.js";
import { mcpSharedDependencies } from "./mcp.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string; jobId?: string };

const STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENTS: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_RETRYABLE: 409,
};

export const registerFailedJobRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  const handle =
    (tool: typeof listFailedJobsTool, args: (params: Params) => unknown) =>
    async (request: FastifyRequest<{ Params: Params }>, response: FastifyReply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(response, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      try {
        const result: ToolResult = await tool(args(request.params), authentication.userId, {
          ...mcpSharedDependencies(options.dependencies),
          authenticate: async () => authentication,
        });
        return result.ok
          ? response.send(result.value)
          : sendError(response, STATUS[result.error] ?? 500, {
              code: result.error,
              message: "Request failed",
            });
      } catch {
        return unexpectedError(response);
      }
    };

  app.get<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/failed-jobs",
    handle(listFailedJobsTool, ({ workspaceId }) => ({ workspaceId })),
  );
  app.post<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/failed-jobs/:jobId/retry",
    handle(retryFailedJobTool, ({ workspaceId, jobId }) => ({ workspaceId, jobId })),
  );
};
