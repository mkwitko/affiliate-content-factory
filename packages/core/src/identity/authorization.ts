import type { MembershipRole, UserId, WorkspaceId } from "@money-maker/contracts";

export type WorkspaceMembership = Readonly<{
  userId: UserId;
  workspaceId: WorkspaceId;
  role: MembershipRole;
  status: "active" | "revoked";
}>;

export type AuthorizedWorkspaceContext = Readonly<{
  userId: UserId;
  workspaceId: WorkspaceId;
  role: MembershipRole;
}>;

type AuthorizationResult =
  | Readonly<{ ok: true; context: AuthorizedWorkspaceContext }>
  | Readonly<{ ok: false; error: Readonly<{ code: "FORBIDDEN"; message: "Access denied" }> }>;

type AuthorizeWorkspaceInput = Readonly<{
  actorId: UserId;
  workspaceId: WorkspaceId;
  membership: WorkspaceMembership | null;
  allowedRoles: readonly MembershipRole[];
}>;

const forbidden: AuthorizationResult = {
  ok: false,
  error: { code: "FORBIDDEN", message: "Access denied" },
};

export const authorizeWorkspace = (input: AuthorizeWorkspaceInput): AuthorizationResult => {
  const { actorId, workspaceId, membership, allowedRoles } = input;

  if (
    membership?.status !== "active" ||
    membership.userId !== actorId ||
    membership.workspaceId !== workspaceId ||
    !allowedRoles.includes(membership.role)
  ) {
    return forbidden;
  }

  return {
    ok: true,
    context: { userId: actorId, workspaceId, role: membership.role },
  };
};
