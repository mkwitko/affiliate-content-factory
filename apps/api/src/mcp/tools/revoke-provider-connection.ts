import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeProviderWorkspace, providerDependencies } from "./create-provider-connection.js";

export const revokeProviderConnectionInputSchema = z
  .object({ workspaceId: z.uuid(), connectionId: z.string().trim().min(1) })
  .strict()
  .describe("Revoke a workspace-owned provider connection and delete its stored secret.");

export const revokeProviderConnectionTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = revokeProviderConnectionInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };

  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = await authorizeProviderWorkspace(dependencies, actorId, workspaceId, [
    "owner",
    "operator",
  ]);
  if (authorization) return authorization;

  const { connections, secrets } = providerDependencies(dependencies, workspaceId);
  const connection = await connections.findForWorkspace({
    workspaceId,
    connectionId: parsed.data.connectionId,
  });
  if (!connection) return { ok: false, error: "CONNECTION_NOT_FOUND" };

  await connections.revoke({ workspaceId, connectionId: connection.id });
  await secrets.delete(connection.secretReference);
  return { ok: true, value: { revoked: true, connectionId: connection.id } };
};
