import type { UserId } from "@money-maker/contracts";
import { normalizeInvitationEmail, type InvitationDependencies } from "./invitation-repository.js";

export type AcceptInvitationCommand = Readonly<{
  userId: UserId;
  email: string;
  token: string;
}>;

export type AcceptInvitationResult =
  | Readonly<{ ok: true; status: "accepted" | "already_accepted"; invitationId: string }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code:
          | "INVITATION_NOT_FOUND"
          | "INVITATION_EMAIL_MISMATCH"
          | "INVITATION_EXPIRED"
          | "INVITATION_REVOKED"
          | "INVITATION_ALREADY_USED";
        message: string;
      }>;
    }>;

const error = (
  code: Exclude<AcceptInvitationResult, { ok: true }>["error"]["code"],
  message: string,
): AcceptInvitationResult => ({
  ok: false,
  error: { code, message },
});

export const acceptInvitation = async (
  command: AcceptInvitationCommand,
  dependencies: InvitationDependencies,
): Promise<AcceptInvitationResult> => {
  const tokenHash = await dependencies.tokenHasher.hash(command.token);
  const invitation = await dependencies.invitations.findByTokenHash({ tokenHash });

  if (!invitation) {
    return error("INVITATION_NOT_FOUND", "Invitation not found");
  }

  if (normalizeInvitationEmail(command.email) !== invitation.email) {
    return error("INVITATION_EMAIL_MISMATCH", "Invitation email does not match");
  }

  if (invitation.status === "revoked") {
    return error("INVITATION_REVOKED", "Invitation has been revoked");
  }

  if (invitation.status === "accepted") {
    if (invitation.acceptedBy && invitation.acceptedBy !== command.userId) {
      return error("INVITATION_ALREADY_USED", "Invitation has already been used");
    }
    return { ok: true, status: "already_accepted", invitationId: invitation.id };
  }

  if (invitation.expiresAt <= dependencies.clock.now()) {
    return error("INVITATION_EXPIRED", "Invitation has expired");
  }

  const status = await dependencies.invitations.acceptPending({
    invitationId: invitation.id,
    acceptedAt: dependencies.clock.now(),
    userId: command.userId,
    auditEvent: {
      action: "workspace.invitation.accepted",
      workspaceId: invitation.workspaceId,
      actorUserId: command.userId,
      invitationId: invitation.id,
    },
    ensureMembership: () =>
      dependencies.memberships.ensureMembership({
        userId: command.userId,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      }),
  });

  if (status === "expired") {
    return error("INVITATION_EXPIRED", "Invitation has expired");
  }
  if (status === "revoked") {
    return error("INVITATION_REVOKED", "Invitation has been revoked");
  }
  if (status === "not_found") {
    return error("INVITATION_NOT_FOUND", "Invitation not found");
  }
  if (status === "already_used") {
    return error("INVITATION_ALREADY_USED", "Invitation has already been used");
  }

  return { ok: true, status, invitationId: invitation.id };
};
