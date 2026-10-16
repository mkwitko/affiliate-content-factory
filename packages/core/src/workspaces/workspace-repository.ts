import type { MembershipRole, UserId, WorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "../identity/authorization.js";

export type WorkspaceRecord = Readonly<{
  id: WorkspaceId;
  name: string;
}>;

export type WorkspaceMembershipSummary = Readonly<WorkspaceRecord & { role: MembershipRole }>;

export type CreateWorkspaceInput = Readonly<{
  id: WorkspaceId;
  name: string;
  owner: Readonly<{ id: UserId; email: string }>;
}>;

export type FindWorkspaceForMemberInput = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
}>;

export type FindMembershipInput = FindWorkspaceForMemberInput;

export type AddMembershipInput = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
  role: MembershipRole;
}>;

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  findByIdForMember(input: FindWorkspaceForMemberInput): Promise<WorkspaceRecord | null>;
  findMembership(input: FindMembershipInput): Promise<WorkspaceMembership | null>;
  listForMember?(userId: UserId): Promise<readonly WorkspaceMembershipSummary[]>;
  addMembership(input: AddMembershipInput): Promise<void>;
  getContext?(workspaceId: WorkspaceId): Promise<Record<string, unknown> | null>;
  updateContext?(input: {
    workspaceId: WorkspaceId;
    context: Record<string, unknown>;
  }): Promise<void>;
}
