import type { UserId, WorkspaceId } from "@money-maker/contracts";
import { authorizeWorkspace } from "./authorization.js";
import {
  normalizeInvitationEmail,
  type InvitationDependencies,
  type InvitationRole,
} from "./invitation-repository.js";

export type CreateInvitationCommand = Readonly<{
  actorId: UserId;
  workspaceId: WorkspaceId;
  email: string;
  role: InvitationRole;
  expiresAt: Date;
}>;

export type CreateInvitationResult =
  | Readonly<{
      ok: true;
      invitation: Readonly<{
        id: string;
        workspaceId: WorkspaceId;
        email: string;
        role: InvitationRole;
        expiresAt: Date;
      }>;
      token: string;
      auditId: string;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "FORBIDDEN" | "INVALID_EMAIL" | "INVALID_EXPIRY";
        message: string;
      }>;
    }>;

export const createInvitation = async (
  command: CreateInvitationCommand,
  dependencies: InvitationDependencies,
): Promise<CreateInvitationResult> => {
  const membership = await dependencies.memberships.findByUserAndWorkspace({
    userId: command.actorId,
    workspaceId: command.workspaceId,
  });
  const authorization = authorizeWorkspace({
    actorId: command.actorId,
    workspaceId: command.workspaceId,
    membership,
    allowedRoles: ["owner"],
  });

  if (!authorization.ok) {
    return authorization;
  }

  const email = normalizeInvitationEmail(command.email);
  if (!email?.includes("@")) {
    return { ok: false, error: { code: "INVALID_EMAIL", message: "A valid email is required" } };
  }

  const now = dependencies.clock.now();
  if (command.expiresAt <= now) {
    return {
      ok: false,
      error: { code: "INVALID_EXPIRY", message: "Invitation expiry must be in the future" },
    };
  }

  const token = dependencies.tokens.generate();
  const tokenHash = await dependencies.tokenHasher.hash(token);
  const created = await dependencies.invitations.create(
    {
      workspaceId: command.workspaceId,
      email,
      role: command.role,
      tokenHash,
      expiresAt: command.expiresAt,
      invitedBy: command.actorId,
    },
    {
      action: "workspace.invitation.created",
      workspaceId: command.workspaceId,
      actorUserId: command.actorId,
    },
  );

  return {
    ok: true,
    invitation: {
      id: created.invitation.id,
      workspaceId: created.invitation.workspaceId,
      email: created.invitation.email,
      role: created.invitation.role,
      expiresAt: created.invitation.expiresAt,
    },
    token,
    auditId: created.auditId,
  };
};
