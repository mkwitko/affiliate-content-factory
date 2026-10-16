import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

export const getWorkspaceInputSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .describe("Read the workspace the authenticated user is allowed to access.");

export const getWorkspaceTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getWorkspaceInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };

  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const membership = await dependencies.invitation.memberships.findByUserAndWorkspace({
    userId: actorId,
    workspaceId,
  });
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership,
    allowedRoles: ["owner", "operator", "reviewer"],
  });
  if (!authorization.ok) return { ok: false, error: "FORBIDDEN" };

  const workspace = await dependencies.workspaces.findByIdForMember({
    workspaceId,
    userId: actorId,
  });
  if (!workspace) return { ok: false, error: "FORBIDDEN" };

  return { ok: true, value: { workspace } };
};
