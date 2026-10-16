import {
  parseUserId,
  parseWorkspaceId,
  type MembershipRole,
  type WorkspaceId,
} from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type {
  AddMembershipInput,
  CreateWorkspaceInput,
  FindWorkspaceForMemberInput,
  FindMembershipInput,
  WorkspaceRecord,
  WorkspaceMembershipSummary,
  WorkspaceRepository,
} from "@money-maker/core/workspaces/workspace-repository";
import type { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const databaseRole = (role: MembershipRole): "OWNER" | "OPERATOR" | "REVIEWER" => {
  switch (role) {
    case "owner":
      return "OWNER";
    case "operator":
      return "OPERATOR";
    case "reviewer":
      return "REVIEWER";
  }
};

const domainRole = (role: "OWNER" | "OPERATOR" | "REVIEWER"): MembershipRole => {
  switch (role) {
    case "OWNER":
      return "owner";
    case "OPERATOR":
      return "operator";
    case "REVIEWER":
      return "reviewer";
  }
};

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    return this.client.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: input.owner.id },
        create: { id: input.owner.id, email: input.owner.email.toLowerCase() },
        update: {},
      });
      const workspace = await transaction.workspace.create({
        data: { id: input.id, name: input.name },
        select: { id: true, name: true },
      });
      await transaction.membership.create({
        data: {
          workspaceId: input.id,
          userId: input.owner.id,
          role: "OWNER",
        },
      });
      return { ...workspace, id: parseWorkspaceId(workspace.id) };
    });
  }

  public async findByIdForMember(
    input: FindWorkspaceForMemberInput,
  ): Promise<WorkspaceRecord | null> {
    const workspace = await this.client.workspace.findFirst({
      where: {
        id: input.workspaceId,
        memberships: {
          some: { userId: input.userId, status: "ACTIVE" },
        },
      },
      select: { id: true, name: true },
    });

    return workspace ? { ...workspace, id: parseWorkspaceId(workspace.id) } : null;
  }

  public async findMembership(input: FindMembershipInput): Promise<WorkspaceMembership | null> {
    const membership = await this.client.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
      select: { workspaceId: true, userId: true, role: true, status: true },
    });

    return membership
      ? {
          workspaceId: parseWorkspaceId(membership.workspaceId),
          userId: parseUserId(membership.userId),
          role: domainRole(membership.role),
          status: membership.status === "ACTIVE" ? "active" : "revoked",
        }
      : null;
  }

  public async listForMember(
    userId: Parameters<NonNullable<WorkspaceRepository["listForMember"]>>[0],
  ): Promise<readonly WorkspaceMembershipSummary[]> {
    const memberships = await this.client.membership.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { workspace: { name: "asc" } },
      select: { workspace: { select: { id: true, name: true } }, role: true },
    });
    return memberships.map((membership) => ({
      id: parseWorkspaceId(membership.workspace.id),
      name: membership.workspace.name,
      role: domainRole(membership.role),
    }));
  }

  public async addMembership(input: AddMembershipInput): Promise<void> {
    await this.client.membership.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: databaseRole(input.role),
      },
    });
  }

  public async getContext(workspaceId: WorkspaceId): Promise<Record<string, unknown> | null> {
    const record = await this.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { context: true },
    });
    return (record?.context as Record<string, unknown> | null) ?? null;
  }

  public async updateContext(input: {
    workspaceId: WorkspaceId;
    context: Record<string, unknown>;
  }): Promise<void> {
    await this.client.workspace.update({
      where: { id: input.workspaceId },
      data: { context: input.context as Prisma.InputJsonValue },
    });
  }
}
