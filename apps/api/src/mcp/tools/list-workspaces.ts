import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";

export const listWorkspacesInputSchema = z.object({}).strict();

export const listWorkspacesTool = async (
  _: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listWorkspacesInputSchema.safeParse(_);
  if (!parsed.success || !dependencies.workspaces.listForMember)
    return parsed.success
      ? (() => {
          throw new Error("Workspace listing is not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  return { ok: true, value: { workspaces: await dependencies.workspaces.listForMember(actorId) } };
};
