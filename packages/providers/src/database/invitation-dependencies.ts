import { createHash, randomBytes } from "node:crypto";
import type { AuditPort, AuditEvent } from "@money-maker/core/audit/audit-port";
import type {
  InvitationDependencies,
  InvitationRecord,
  InvitationRole,
  MembershipRepository,
  InvitationRepository,
} from "@money-maker/core/identity/invitation-repository";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";

const databaseRole = (role: InvitationRole): "OPERATOR" | "REVIEWER" =>
  role === "operator" ? "OPERATOR" : "REVIEWER";

const invitationRole = (role: "OWNER" | "OPERATOR" | "REVIEWER"): InvitationRole => {
  if (role === "OPERATOR") return "operator";
  if (role === "REVIEWER") return "reviewer";
  throw new Error("Invitation role cannot be owner");
};

const invitationStatus = (status: "PENDING" | "ACCEPTED" | "REVOKED"): InvitationRecord["status"] =>
  status.toLowerCase() as InvitationRecord["status"];

const mapInvitation = (record: {
  id: string;
  workspaceId: string;
  email: string;
  role: "OWNER" | "OPERATOR" | "REVIEWER";
  tokenHash: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED";
  expiresAt: Date;
  createdById: string;
  acceptedById: string | null;
  acceptedAt: Date | null;
}): InvitationRecord => ({
  id: record.id,
  workspaceId: parseWorkspaceId(record.workspaceId),
  email: record.email,
  role: invitationRole(record.role),
  tokenHash: record.tokenHash,
  status: invitationStatus(record.status),
  expiresAt: record.expiresAt,
  invitedBy: parseUserId(record.createdById),
  ...(record.acceptedById ? { acceptedBy: parseUserId(record.acceptedById) } : {}),
  ...(record.acceptedAt ? { acceptedAt: record.acceptedAt } : {}),
});

const mapMembership = (record: {
  workspaceId: string;
  userId: string;
  role: "OWNER" | "OPERATOR" | "REVIEWER";
  status: "ACTIVE" | "REVOKED";
}): WorkspaceMembership => ({
  workspaceId: parseWorkspaceId(record.workspaceId),
  userId: parseUserId(record.userId),
  role: record.role.toLowerCase() as WorkspaceMembership["role"],
  status: record.status.toLowerCase() as WorkspaceMembership["status"],
});

export const createPrismaMembershipRepository = (
  client: Pick<DatabaseClient, "membership">,
): MembershipRepository => ({
  findByUserAndWorkspace: async ({ userId, workspaceId }) => {
    const record = await client.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
      select: { workspaceId: true, userId: true, role: true, status: true },
    });
    return record ? mapMembership(record) : null;
  },
  ensureMembership: async ({ userId, workspaceId, role }) => {
    const existing = await client.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    await client.membership.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: {
        workspaceId,
        userId,
        role: databaseRole(role),
        status: "ACTIVE",
      },
      update: {},
    });
    return existing ? "existing" : "created";
  },
});

export const createPrismaInvitationRepository = (client: DatabaseClient): InvitationRepository => ({
  create: async (input, auditEvent) =>
    client.$transaction(async (transaction) => {
      const record = await transaction.invitation.create({
        data: {
          workspaceId: input.workspaceId,
          email: input.email,
          role: databaseRole(input.role),
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.invitedBy,
        },
        select: {
          id: true,
          workspaceId: true,
          email: true,
          role: true,
          tokenHash: true,
          status: true,
          expiresAt: true,
          createdById: true,
          acceptedById: true,
          acceptedAt: true,
        },
      });
      const auditId = await createPrismaAuditPort(transaction).record({
        ...auditEvent,
        invitationId: record.id,
      });
      return { invitation: mapInvitation(record), auditId };
    }),
  findByTokenHash: async ({ tokenHash }) => {
    const record = await client.invitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        role: true,
        tokenHash: true,
        status: true,
        expiresAt: true,
        createdById: true,
        acceptedById: true,
        acceptedAt: true,
      },
    });
    return record ? mapInvitation(record) : null;
  },
  acceptPending: async ({ invitationId, userId, auditEvent }) =>
    client.$transaction(async (transaction) => {
      const record = await transaction.invitation.findUnique({
        where: { id: invitationId },
        select: { workspaceId: true, role: true, status: true, acceptedById: true },
      });
      if (!record) return "not_found";
      if (record.status === "REVOKED") return "revoked";
      if (record.status === "ACCEPTED") {
        return record.acceptedById === userId ? "already_accepted" : "already_used";
      }
      const role = invitationRole(record.role);

      // Database time is authoritative, including time spent waiting for a row
      // lock. A caller timestamp or transaction-start timestamp can be stale.
      const updated = await transaction.$queryRaw<Array<{ id: string }>>`
        UPDATE "invitations"
        SET "status" = 'ACCEPTED', "accepted_at" = clock_timestamp(),
            "accepted_by_id" = ${userId}::uuid, "updated_at" = clock_timestamp()
        WHERE "id" = ${invitationId}::uuid AND "workspace_id" = ${record.workspaceId}::uuid
          AND "status" = 'PENDING' AND "expires_at" > clock_timestamp()
        RETURNING "id"
      `;
      if (updated.length !== 1) {
        const current = await transaction.$queryRaw<
          Array<{
            status: "PENDING" | "ACCEPTED" | "REVOKED";
            expired: boolean;
            acceptedById: string | null;
          }>
        >`
          SELECT "status", "accepted_by_id" AS "acceptedById",
                 ("status" = 'PENDING' AND "expires_at" <= clock_timestamp()) AS "expired"
          FROM "invitations"
          WHERE "id" = ${invitationId}::uuid AND "workspace_id" = ${record.workspaceId}::uuid
        `;
        const currentRecord = current[0];
        if (!currentRecord) return "not_found";
        if (currentRecord.status === "REVOKED") return "revoked";
        if (currentRecord.status === "ACCEPTED") {
          return currentRecord.acceptedById === userId ? "already_accepted" : "already_used";
        }
        return currentRecord.expired ? "expired" : "already_used";
      }

      // Bind the membership operation to this transaction instead of invoking
      // the caller's callback, which may use a different connection.
      await createPrismaMembershipRepository(transaction).ensureMembership({
        workspaceId: parseWorkspaceId(record.workspaceId),
        userId,
        role,
      });
      await createPrismaAuditPort(transaction).record(auditEvent);
      return "accepted";
    }),
});

export const createPrismaAuditPort = (client: Pick<DatabaseClient, "auditEvent">): AuditPort => ({
  record: async (event: AuditEvent) => {
    // There is no actor_type column; a system actor's name rides in metadata instead, and
    // actor_user_id (nullable) stays null for it.
    const metadata = event.systemActor
      ? { ...event.metadata, systemActor: event.systemActor }
      : event.metadata;
    const auditEvent = await client.auditEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actorUserId: event.actorUserId ?? null,
        action: event.action,
        targetType: event.targetType ?? "Invitation",
        targetId: event.targetId ?? event.invitationId ?? null,
        ...(metadata ? { metadata } : {}),
      },
      select: { id: true },
    });
    return auditEvent.id;
  },
});

export const createInvitationDependencies = (client: DatabaseClient): InvitationDependencies => ({
  memberships: createPrismaMembershipRepository(client),
  invitations: createPrismaInvitationRepository(client),
  audit: createPrismaAuditPort(client),
  clock: { now: () => new Date() },
  tokens: { generate: () => randomBytes(32).toString("base64url") },
  tokenHasher: {
    hash: async (token) => createHash("sha256").update(token).digest("hex"),
  },
});
