import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import {
  authorizeProviderWorkspace,
  providerDependencies,
  publicProviderConnection,
} from "./create-provider-connection.js";

export const listProviderConnectionsInputSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .describe("List redacted provider connections owned by a workspace.");

export const listProviderConnectionsTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listProviderConnectionsInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };

  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = await authorizeProviderWorkspace(dependencies, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (authorization) return authorization;

  const { connections } = providerDependencies(dependencies, workspaceId);
  const records = await connections.findAllForWorkspace({ workspaceId });
  return { ok: true, value: { connections: records.map(publicProviderConnection) } };
};
