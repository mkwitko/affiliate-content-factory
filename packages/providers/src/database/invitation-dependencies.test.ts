import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";
import * as adapters from "./invitation-dependencies.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-21T12:00:00.000Z");
const creationAudit = {
  workspaceId,
  actorUserId: userId,
  action: "workspace.invitation.created" as const,
};
const acceptanceAudit = {
  workspaceId,
  actorUserId: userId,
  action: "workspace.invitation.accepted" as const,
  invitationId: "invitation-1",
};
const row = {
  id: "invitation-1",
  workspaceId,
  email: "friend@example.test",
  role: "REVIEWER" as const,
  tokenHash: "hash",
  status: "PENDING" as const,
  expiresAt: now,
  createdById: userId,
  acceptedById: null,
  acceptedAt: null,
};

// Only the external Prisma query boundary is replaced; adapter mapping and orchestration run unchanged.
const clientFixture = () => {
  const transaction = {
    invitation: {
      create: vi.fn().mockResolvedValue(row),
      findUnique: vi.fn().mockResolvedValue(row),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-event-1" }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: row.id }]),
  };
  const queries = {
    invitation: {
      create: vi.fn().mockResolvedValue(row),
      findUnique: vi.fn().mockResolvedValue(row),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-event-1" }) },
    $transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
  };
  return { client: queries as unknown as DatabaseClient, queries, transaction };
};

describe("Prisma invitation dependency adapters", () => {
  it("exports independently composable repository and audit adapters", () => {
    expect(adapters).toHaveProperty("createPrismaInvitationRepository", expect.any(Function));
    expect(adapters).toHaveProperty("createPrismaMembershipRepository", expect.any(Function));
    expect(adapters).toHaveProperty("createPrismaAuditPort", expect.any(Function));
  });

  it("maps persisted invitations and stores only the supplied hash", async () => {
    const { client, queries, transaction } = clientFixture();
    const { invitations } = adapters.createInvitationDependencies(client);
    const created = await invitations.create(
      {
        workspaceId,
        email: "friend@example.test",
        role: "reviewer",
        tokenHash: "hash",
        expiresAt: now,
        invitedBy: userId,
      },
      creationAudit,
    );
    expect(transaction.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId,
          email: "friend@example.test",
          role: "REVIEWER",
          tokenHash: "hash",
          expiresAt: now,
          createdById: userId,
        },
      }),
    );
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "workspace.invitation.created",
        targetType: "Invitation",
        targetId: row.id,
      },
      select: { id: true },
    });
    expect(queries.invitation.create).not.toHaveBeenCalled();
    expect(queries.auditEvent.create).not.toHaveBeenCalled();
    expect(created).toEqual({
      invitation: {
        id: "invitation-1",
        workspaceId,
        email: "friend@example.test",
        role: "reviewer",
        tokenHash: "hash",
        status: "pending",
        expiresAt: now,
        invitedBy: userId,
      },
      auditId: "audit-event-1",
    });
    queries.invitation.findUnique.mockResolvedValueOnce({
      ...row,
      status: "ACCEPTED",
      acceptedAt: now,
      acceptedById: userId,
    });
    expect(await invitations.findByTokenHash({ tokenHash: "hash" })).toEqual({
      ...created.invitation,
      status: "accepted",
      acceptedAt: now,
      acceptedBy: userId,
    });
    expect(queries.invitation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: "hash" } }),
    );
    queries.invitation.findUnique.mockResolvedValueOnce(null);
    expect(await invitations.findByTokenHash({ tokenHash: "absent" })).toBeNull();
  });

  it("scopes membership lookup to both user and workspace and maps database enums", async () => {
    const { client, queries } = clientFixture();
    queries.membership.findUnique.mockResolvedValueOnce({
      userId,
      workspaceId,
      role: "OWNER",
      status: "REVOKED",
    });
    const { memberships } = adapters.createInvitationDependencies(client);
    expect(await memberships.findByUserAndWorkspace({ userId, workspaceId })).toEqual({
      userId,
      workspaceId,
      role: "owner",
      status: "revoked",
    });
    expect(queries.membership.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId_userId: { userId, workspaceId } } }),
    );
    expect(await memberships.findByUserAndWorkspace({ userId, workspaceId })).toBeNull();
  });

  it("does not overwrite an existing member's role when ensuring membership", async () => {
    const { client, queries } = clientFixture();
    const { memberships } = adapters.createInvitationDependencies(client);
    expect(await memberships.ensureMembership({ userId, workspaceId, role: "reviewer" })).toBe(
      "created",
    );
    queries.membership.findUnique.mockResolvedValueOnce({ userId });
    expect(await memberships.ensureMembership({ userId, workspaceId, role: "reviewer" })).toBe(
      "existing",
    );
    expect(queries.membership.upsert).toHaveBeenLastCalledWith({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "REVIEWER", status: "ACTIVE" },
      update: {},
    });
  });

  it("accepts and ensures membership using the same transaction, scoped to the invitation workspace", async () => {
    const { client, queries, transaction } = clientFixture();
    const { invitations } = adapters.createInvitationDependencies(client);
    const ensureMembership = vi.fn();
    const input = {
      invitationId: row.id,
      userId,
      acceptedAt: now,
      ensureMembership,
      auditEvent: acceptanceAudit,
    };
    expect(await invitations.acceptPending(input)).toBe("accepted");
    const [sql, ...parameters] = transaction.$queryRaw.mock.calls[0] ?? [];
    expect(sql?.join("?")).toContain('"expires_at" > clock_timestamp()');
    expect(sql?.join("?")).toContain('"workspace_id" = ?::uuid');
    expect(parameters).toEqual([userId, row.id, workspaceId]);
    expect(transaction.membership.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "REVIEWER", status: "ACTIVE" },
      update: {},
    });
    expect(queries.membership.upsert).not.toHaveBeenCalled();
    expect(ensureMembership).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "workspace.invitation.accepted",
        targetType: "Invitation",
        targetId: row.id,
      },
      select: { id: true },
    });
    expect(queries.auditEvent.create).not.toHaveBeenCalled();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: "ACCEPTED", acceptedById: userId, expired: false }]);
    expect(await invitations.acceptPending(input)).toBe("already_accepted");
    expect(transaction.membership.upsert).toHaveBeenCalledTimes(1);
    transaction.invitation.findUnique.mockResolvedValueOnce({
      ...row,
      status: "ACCEPTED",
      acceptedById: userId,
    });
    expect(await invitations.acceptPending(input)).toBe("already_accepted");
    expect(transaction.membership.upsert).toHaveBeenCalledTimes(1);
    expect(transaction.auditEvent.create).toHaveBeenCalledTimes(1);
  });

  it("returns expired when database time rejects the conditional write, without membership or audit", async () => {
    const { client, transaction } = clientFixture();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: "PENDING", acceptedById: null, expired: true }]);
    const result = await adapters.createInvitationDependencies(client).invitations.acceptPending({
      invitationId: row.id,
      userId,
      acceptedAt: now,
      ensureMembership: async () => "created",
      auditEvent: acceptanceAudit,
    });
    expect(result).toBe("expired");
    expect(transaction.membership.upsert).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked", { ...row, status: "REVOKED" as const }, "revoked"],
    ["missing", null, "not_found"],
    [
      "already used",
      { ...row, status: "ACCEPTED" as const, acceptedById: "another-user" },
      "already_used",
    ],
  ] as const)("distinguishes %s at the transaction boundary", async (_name, record, expected) => {
    const { client, transaction } = clientFixture();
    transaction.invitation.findUnique.mockResolvedValueOnce(record);
    const result = await adapters.createInvitationDependencies(client).invitations.acceptPending({
      invitationId: row.id,
      userId,
      acceptedAt: now,
      ensureMembership: async () => "created",
      auditEvent: acceptanceAudit,
    });
    expect(result).toBe(expected);
    expect(transaction.membership.upsert).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each(["creation", "acceptance"])(
    "rejects %s when transactional audit persistence fails",
    async (operation) => {
      const { client, transaction, queries } = clientFixture();
      transaction.auditEvent.create.mockRejectedValueOnce(new Error("Audit persistence failed"));
      const { invitations } = adapters.createInvitationDependencies(client);
      const result =
        operation === "creation"
          ? invitations.create(
              {
                workspaceId,
                email: row.email,
                role: "reviewer",
                tokenHash: "hash",
                expiresAt: now,
                invitedBy: userId,
              },
              creationAudit,
            )
          : invitations.acceptPending({
              invitationId: row.id,
              userId,
              acceptedAt: now,
              ensureMembership: async () => "created",
              auditEvent: acceptanceAudit,
            });
      await expect(result).rejects.toThrow("Audit persistence failed");
      expect(queries.auditEvent.create).not.toHaveBeenCalled();
    },
  );

  it("persists workspace-scoped audit records without the invitation token", async () => {
    const { client, queries } = clientFixture();
    await adapters.createInvitationDependencies(client).audit.record({
      workspaceId,
      actorUserId: userId,
      action: "workspace.invitation.created",
      invitationId: row.id,
    });
    expect(queries.auditEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "workspace.invitation.created",
        targetType: "Invitation",
        targetId: row.id,
      },
      select: { id: true },
    });
  });

  it("generates unpredictable URL-safe tokens and hashes with SHA-256", async () => {
    const { tokens, tokenHasher } = adapters.createInvitationDependencies(clientFixture().client);
    const first = tokens.generate();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.generate()).not.toBe(first);
    expect(await tokenHasher.hash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
