import type { MembershipRole, UserId, WorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "./authorization.js";
import type { AuditEvent } from "../audit/audit-port.js";

export type InvitationRole = Exclude<MembershipRole, "owner">;
export type InvitationStatus = "pending" | "accepted" | "revoked";

export type InvitationRecord = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  invitedBy: UserId;
  acceptedBy?: UserId;
  acceptedAt?: Date;
}>;

export type CreateInvitationRecordInput = Readonly<{
  workspaceId: WorkspaceId;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  expiresAt: Date;
  invitedBy: UserId;
}>;

export type CreatedInvitation = Readonly<{
  invitation: InvitationRecord;
  auditId: string;
}>;

export interface MembershipRepository {
  findByUserAndWorkspace(
    input: Readonly<{ userId: UserId; workspaceId: WorkspaceId }>,
  ): Promise<WorkspaceMembership | null>;
  ensureMembership(
    input: Readonly<{ userId: UserId; workspaceId: WorkspaceId; role: InvitationRole }>,
  ): Promise<"created" | "existing">;
}

export interface InvitationRepository {
  /** Persist the invitation and its audit event atomically. */
  create(
    input: CreateInvitationRecordInput,
    auditEvent: Omit<AuditEvent, "invitationId">,
  ): Promise<CreatedInvitation>;
  findByTokenHash(input: Readonly<{ tokenHash: string }>): Promise<InvitationRecord | null>;
  /** Check expiry at the write boundary; accept, ensure membership, and audit atomically. */
  acceptPending(
    input: Readonly<{
      invitationId: string;
      acceptedAt: Date;
      userId: UserId;
      ensureMembership: () => Promise<"created" | "existing">;
      auditEvent: AuditEvent;
    }>,
  ): Promise<
    "accepted" | "already_accepted" | "already_used" | "expired" | "revoked" | "not_found"
  >;
}

export type InvitationDependencies = Readonly<{
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  audit: import("../audit/audit-port.js").AuditPort;
  clock: Readonly<{ now(): Date }>;
  tokens: Readonly<{ generate(): string }>;
  tokenHasher: Readonly<{ hash(token: string): Promise<string> }>;
}>;

export const normalizeInvitationEmail = (email: string): string => email.trim().toLowerCase();
