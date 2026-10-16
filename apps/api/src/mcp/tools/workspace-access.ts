import {
  parseWorkspaceId,
  type MembershipRole,
  type UserId,
  type WorkspaceId,
} from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import type { McpDependencies, ToolResult } from "../server.js";

export const parseWorkspaceArgument = (value: string): WorkspaceId | null => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

export const authorizeWorkspaceTool = async (
  dependencies: McpDependencies,
  actorId: UserId,
  workspaceId: WorkspaceId,
  roles: readonly MembershipRole[],
): Promise<ToolResult | null> => {
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles: roles,
  });
  return authorization.ok ? null : { ok: false, error: "FORBIDDEN" };
};

export const requireList = <T>(
  repository: { listForWorkspace?(workspaceId: WorkspaceId): Promise<readonly T[]> } | undefined,
) => {
  const list = repository?.listForWorkspace;
  if (!repository || !list) throw new Error("Repository list operation is not configured.");
  // Keep the repository as receiver; class-based repositories depend on `this`.
  return (workspaceId: WorkspaceId) => list.call(repository, workspaceId);
};
