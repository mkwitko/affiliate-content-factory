import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDependencies } from "../app.js";
import { sendError, unexpectedError } from "../http/errors.js";
import { listAffiliateLinkQueueTool } from "../mcp/tools/list-affiliate-link-queue.js";
import { submitAffiliateLinksTool } from "../mcp/tools/submit-affiliate-links.js";
import type { ToolResult } from "../mcp/tool-result.js";
import { mcpSharedDependencies } from "./mcp.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string };

const STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENTS: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
};
const statusFor = (error: string): number => STATUS[error] ?? 500;

const reply = (response: FastifyReply, result: ToolResult) =>
  result.ok
    ? response.send(result.value)
    : sendError(response, statusFor(result.error), {
        code: result.error,
        message: "Request failed",
      });

export const registerAffiliateLinkRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  // Same tools the MCP server exposes, so validation and business rules live in one place.
  const handle =
    (
      tool: typeof listAffiliateLinkQueueTool | typeof submitAffiliateLinksTool,
      args: (workspaceId: string, body: unknown) => unknown,
    ) =>
    async (request: FastifyRequest<{ Params: Params; Body: unknown }>, response: FastifyReply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(response, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      try {
        return reply(
          response,
          await tool(args(request.params.workspaceId, request.body), authentication.userId, {
            ...mcpSharedDependencies(options.dependencies),
            authenticate: async () => authentication,
          }),
        );
      } catch {
        return unexpectedError(response);
      }
    };

  app.get<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/affiliate-link-queue",
    handle(listAffiliateLinkQueueTool, (workspaceId) => ({ workspaceId })),
  );
  app.post<{ Params: Params; Body: unknown }>(
    "/v1/workspaces/:workspaceId/affiliate-links",
    handle(submitAffiliateLinksTool, (workspaceId, body) => ({
      ...(typeof body === "object" && body !== null ? body : {}),
      workspaceId,
    })),
  );
};
