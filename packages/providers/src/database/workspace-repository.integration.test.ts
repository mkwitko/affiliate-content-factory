import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createInvitation } from "@money-maker/core/identity/create-invitation";
import { acceptInvitation } from "@money-maker/core/identity/accept-invitation";
import type { DatabaseClient } from "./client.js";
import { createInvitationDependencies } from "./invitation-dependencies.js";

type WorkspaceRecord = { id: string; name: string };

type WorkspaceRepository = {
  create: (input: {
    id: string;
    name: string;
    owner: { id: string; email: string };
  }) => Promise<WorkspaceRecord>;
  findByIdForMember: (input: {
    workspaceId: string;
    userId: string;
  }) => Promise<WorkspaceRecord | null>;
  listForMember: (userId: string) => Promise<
    readonly (WorkspaceRecord & {
      role: "owner" | "operator" | "reviewer";
    })[]
  >;
  addMembership: (input: {
    workspaceId: string;
    userId: string;
    role: "owner" | "operator" | "reviewer";
  }) => Promise<void>;
};

type ProviderApi = {
  createDatabaseClient?: (connectionString: string) => DatabaseClient;
  PrismaWorkspaceRepository?: new (client: DatabaseClient) => WorkspaceRepository;
};

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

const loadProviderApi = async (): Promise<ProviderApi> => {
  const clientModule = (await import("./client.js").catch(() => ({}))) as ProviderApi;
  const repositoryModule = (await import("./workspace-repository.js").catch(
    () => ({}),
  )) as ProviderApi;

  const api = { ...clientModule, ...repositoryModule };
  expect(api.createDatabaseClient).toBeTypeOf("function");
  expect(api.PrismaWorkspaceRepository).toBeTypeOf("function");
  return api;
};

integration("PrismaWorkspaceRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: WorkspaceRepository;

  beforeAll(async () => {
    const api = await loadProviderApi();
    if (!databaseUrl || !api.createDatabaseClient || !api.PrismaWorkspaceRepository) return;
    client = api.createDatabaseClient(databaseUrl);
    repository = new api.PrismaWorkspaceRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.auditEvent.deleteMany();
    await client.invitation.deleteMany();
    await client.membership.deleteMany();
    await client.workspace.deleteMany();
    await client.user.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const createWorkspace = async (name: string) => {
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    await repository.create({
      id: workspaceId,
      name,
      owner: { id: ownerId, email: `${ownerId}@example.test` },
    });
    return { ownerId, workspaceId };
  };

  it("returns a workspace to its active member", async () => {
    const { ownerId, workspaceId } = await createWorkspace("First workspace");

    await expect(repository.findByIdForMember({ workspaceId, userId: ownerId })).resolves.toEqual({
      id: workspaceId,
      name: "First workspace",
    });
  });

  it("does not reveal another workspace", async () => {
    const first = await createWorkspace("First workspace");
    const second = await createWorkspace("Second workspace");

    await expect(
      repository.findByIdForMember({
        workspaceId: first.workspaceId,
        userId: second.ownerId,
      }),
    ).resolves.toBeNull();
  });

  it("lists active memberships in workspace order and excludes revoked memberships", async () => {
    const ownerId = randomUUID();
    const firstWorkspaceId = randomUUID();
    const secondWorkspaceId = randomUUID();
    const thirdWorkspaceId = randomUUID();
    const email = `${ownerId}@example.test`;

    await repository.create({
      id: secondWorkspaceId,
      name: "Bravo workspace",
      owner: { id: ownerId, email },
    });
    await repository.create({
      id: firstWorkspaceId,
      name: "Alpha workspace",
      owner: { id: ownerId, email },
    });
    await repository.create({
      id: thirdWorkspaceId,
      name: "Charlie workspace",
      owner: { id: ownerId, email },
    });
    await client.membership.update({
      where: { workspaceId_userId: { workspaceId: thirdWorkspaceId, userId: ownerId } },
      data: { status: "REVOKED" },
    });

    await expect(repository.listForMember(ownerId)).resolves.toEqual([
      { id: firstWorkspaceId, name: "Alpha workspace", role: "owner" },
      { id: secondWorkspaceId, name: "Bravo workspace", role: "owner" },
    ]);
  });

  it("allows the same owner to create more than one workspace", async () => {
    const ownerId = randomUUID();
    const firstWorkspaceId = randomUUID();
    const secondWorkspaceId = randomUUID();
    const email = `${ownerId}@example.test`;

    await repository.create({
      id: firstWorkspaceId,
      name: "First workspace",
      owner: { id: ownerId, email },
    });
    await expect(
      repository.create({
        id: secondWorkspaceId,
        name: "Second workspace",
        owner: { id: ownerId, email },
      }),
    ).resolves.toEqual({ id: secondWorkspaceId, name: "Second workspace" });
  });

  it("rejects a duplicate membership", async () => {
    const first = await createWorkspace("First workspace");
    const second = await createWorkspace("Second workspace");
    const membership = {
      workspaceId: first.workspaceId,
      userId: second.ownerId,
      role: "operator" as const,
    };

    await repository.addMembership(membership);

    await expect(repository.addMembership(membership)).rejects.toThrow();
  });

  it("does not return a workspace through a revoked membership", async () => {
    const { ownerId, workspaceId } = await createWorkspace("First workspace");
    await client.membership.update({
      where: { workspaceId_userId: { workspaceId, userId: ownerId } },
      data: { status: "REVOKED" },
    });

    await expect(
      repository.findByIdForMember({ workspaceId, userId: ownerId }),
    ).resolves.toBeNull();
  });

  it("persists hashed invitations, accepts once, and records both audit events", async () => {
    const first = await createWorkspace("Invitation workspace");
    const second = await createWorkspace("Invitee's other workspace");
    const dependencies = createInvitationDependencies(client);
    const workspaceId = parseWorkspaceId(first.workspaceId);
    const userId = parseUserId(second.ownerId);
    const email = `${userId}@example.test`;
    const created = await createInvitation(
      {
        actorId: parseUserId(first.ownerId),
        workspaceId,
        email,
        role: "reviewer",
        expiresAt: new Date(Date.now() + 60_000),
      },
      dependencies,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Invitation creation failed");

    const stored = await client.invitation.findUniqueOrThrow({
      where: { id: created.invitation.id },
    });
    expect(stored.tokenHash).not.toBe(created.token);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const command = { userId, email, token: created.token };
    expect(await acceptInvitation(command, dependencies)).toEqual({
      ok: true,
      status: "accepted",
      invitationId: stored.id,
    });
    expect(await acceptInvitation(command, dependencies)).toEqual({
      ok: true,
      status: "already_accepted",
      invitationId: stored.id,
    });
    expect(await client.membership.count({ where: { workspaceId, userId } })).toBe(1);
    expect(await dependencies.memberships.findByUserAndWorkspace({ workspaceId, userId })).toEqual({
      workspaceId,
      userId,
      role: "reviewer",
      status: "active",
    });
    const events = await client.auditEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.action)).toEqual([
      "workspace.invitation.created",
      "workspace.invitation.accepted",
    ]);
    expect(events.map((event) => event.targetId)).toEqual([stored.id, stored.id]);
    expect(JSON.stringify(events)).not.toContain(created.token);
  }, 30_000);

  it("rolls back invitation acceptance when membership persistence fails", async () => {
    const first = await createWorkspace("Rollback workspace");
    const second = await createWorkspace("Invitee workspace");
    // Inject a failure only at the membership write; the invitation update and
    // transaction rollback still execute against real PostgreSQL.
    const failingClient = client.$extends({
      query: {
        membership: {
          upsert: async () => {
            throw new Error("Simulated membership write failure");
          },
        },
      },
    });
    const { invitations } = createInvitationDependencies(
      failingClient as unknown as DatabaseClient,
    );
    const invitation = await invitations.create(
      {
        workspaceId: parseWorkspaceId(first.workspaceId),
        email: "missing@example.test",
        role: "operator",
        tokenHash: "rollback-hash",
        expiresAt: new Date(Date.now() + 60_000),
        invitedBy: parseUserId(first.ownerId),
      },
      {
        workspaceId: parseWorkspaceId(first.workspaceId),
        actorUserId: parseUserId(first.ownerId),
        action: "workspace.invitation.created",
      },
    );
    await expect(
      invitations.acceptPending({
        invitationId: invitation.invitation.id,
        userId: parseUserId(second.ownerId),
        acceptedAt: new Date(),
        auditEvent: {
          workspaceId: invitation.invitation.workspaceId,
          actorUserId: parseUserId(second.ownerId),
          action: "workspace.invitation.accepted",
          invitationId: invitation.invitation.id,
        },
        ensureMembership: async () => {
          throw new Error("Must use the transaction-bound repository");
        },
      }),
    ).rejects.toThrow("Simulated membership write failure");
    expect(await invitations.findByTokenHash({ tokenHash: "rollback-hash" })).toMatchObject({
      status: "pending",
    });
    expect(await client.membership.count({ where: { workspaceId: first.workspaceId } })).toBe(1);
  });

  it("isolates membership lookup and preserves an existing owner's role", async () => {
    const first = await createWorkspace("Owner workspace");
    const second = await createWorkspace("Other workspace");
    const { memberships } = createInvitationDependencies(client);
    const input = {
      workspaceId: parseWorkspaceId(first.workspaceId),
      userId: parseUserId(first.ownerId),
    };
    expect(
      await memberships.findByUserAndWorkspace({
        ...input,
        workspaceId: parseWorkspaceId(second.workspaceId),
      }),
    ).toBeNull();
    expect(await memberships.ensureMembership({ ...input, role: "reviewer" })).toBe("existing");
    expect(await memberships.findByUserAndWorkspace(input)).toMatchObject({
      role: "owner",
      status: "active",
    });
  });

  const failAuditWrites = () =>
    createInvitationDependencies(
      client.$extends({
        query: {
          auditEvent: {
            create: async () => {
              throw new Error("Audit unavailable");
            },
          },
        },
      }) as unknown as DatabaseClient,
    );

  it("rolls back invitation creation when its audit write fails", async () => {
    const first = await createWorkspace("Audit rollback workspace");
    const workspaceId = parseWorkspaceId(first.workspaceId);
    await expect(
      createInvitation(
        {
          actorId: parseUserId(first.ownerId),
          workspaceId,
          email: "friend@example.test",
          role: "reviewer",
          expiresAt: new Date(Date.now() + 60_000),
        },
        failAuditWrites(),
      ),
    ).rejects.toThrow("Audit unavailable");
    expect(await client.invitation.count({ where: { workspaceId } })).toBe(0);
    expect(await client.auditEvent.count({ where: { workspaceId } })).toBe(0);
  });

  it("rolls back acceptance and membership when audit fails, then retries exactly once", async () => {
    const first = await createWorkspace("Acceptance audit rollback");
    const second = await createWorkspace("Invitee workspace");
    const dependencies = createInvitationDependencies(client);
    const workspaceId = parseWorkspaceId(first.workspaceId);
    const userId = parseUserId(second.ownerId);
    const email = `${userId}@example.test`;
    const created = await createInvitation(
      {
        actorId: parseUserId(first.ownerId),
        workspaceId,
        email,
        role: "reviewer",
        expiresAt: new Date(Date.now() + 60_000),
      },
      dependencies,
    );
    if (!created.ok) throw new Error("Invitation creation failed");
    const command = { userId, email, token: created.token };
    await expect(acceptInvitation(command, failAuditWrites())).rejects.toThrow("Audit unavailable");
    expect(
      await client.invitation.findUniqueOrThrow({ where: { id: created.invitation.id } }),
    ).toMatchObject({ status: "PENDING", acceptedAt: null, acceptedById: null });
    expect(await client.membership.count({ where: { workspaceId, userId } })).toBe(0);
    expect(
      await client.auditEvent.count({
        where: { workspaceId, action: "workspace.invitation.accepted" },
      }),
    ).toBe(0);
    expect(await acceptInvitation(command, dependencies)).toMatchObject({
      ok: true,
      status: "accepted",
    });
    expect(await acceptInvitation(command, dependencies)).toMatchObject({
      ok: true,
      status: "already_accepted",
    });
    expect(await client.membership.count({ where: { workspaceId, userId } })).toBe(1);
    expect(
      await client.auditEvent.count({
        where: { workspaceId, action: "workspace.invitation.accepted" },
      }),
    ).toBe(1);
  }, 30_000);

  it("denies expiry at the database boundary even when the caller clock is stale", async () => {
    const first = await createWorkspace("Expired workspace");
    const second = await createWorkspace("Invitee workspace");
    const dependencies = createInvitationDependencies(client);
    const workspaceId = parseWorkspaceId(first.workspaceId);
    const userId = parseUserId(second.ownerId);
    const email = `${userId}@example.test`;
    const invitation = await dependencies.invitations.create(
      {
        workspaceId,
        email,
        role: "reviewer",
        tokenHash: await dependencies.tokenHasher.hash("expired-token"),
        expiresAt: new Date(Date.now() - 60_000),
        invitedBy: parseUserId(first.ownerId),
      },
      {
        workspaceId,
        actorUserId: parseUserId(first.ownerId),
        action: "workspace.invitation.created",
      },
    );
    const result = await acceptInvitation(
      { userId, email, token: "expired-token" },
      {
        ...dependencies,
        clock: { now: () => new Date(Date.now() - 120_000) },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INVITATION_EXPIRED" } });
    expect(
      await client.invitation.findUniqueOrThrow({ where: { id: invitation.invitation.id } }),
    ).toMatchObject({ status: "PENDING" });
    expect(await client.membership.count({ where: { workspaceId, userId } })).toBe(0);
    expect(
      await client.auditEvent.count({
        where: { workspaceId, action: "workspace.invitation.accepted" },
      }),
    ).toBe(0);
  });

  it("denies an invitation that expires between the repository read and conditional write", async () => {
    const first = await createWorkspace("Expiry race workspace");
    const second = await createWorkspace("Invitee workspace");
    const dependencies = createInvitationDependencies(client);
    const workspaceId = parseWorkspaceId(first.workspaceId);
    const userId = parseUserId(second.ownerId);
    const email = `${userId}@example.test`;
    const created = await createInvitation(
      {
        actorId: parseUserId(first.ownerId),
        workspaceId,
        email,
        role: "reviewer",
        expiresAt: new Date(Date.now() + 60_000),
      },
      dependencies,
    );
    if (!created.ok) throw new Error("Invitation creation failed");
    // Advance the persisted expiry after the transaction reads the valid row,
    // deterministically reproducing the race without relying on test timing.
    const racingClient = client.$extends({
      query: {
        invitation: {
          findUnique: async ({ args, query }) => {
            const record = await query(args);
            if (args.where.id === created.invitation.id) {
              await client.invitation.update({
                where: { id: created.invitation.id },
                data: { expiresAt: new Date(Date.now() - 1_000) },
              });
            }
            return record;
          },
        },
      },
    });
    expect(
      await acceptInvitation(
        { userId, email, token: created.token },
        createInvitationDependencies(racingClient as unknown as DatabaseClient),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "INVITATION_EXPIRED" },
    });
    expect(await client.membership.count({ where: { workspaceId, userId } })).toBe(0);
    expect(
      await client.invitation.findUniqueOrThrow({ where: { id: created.invitation.id } }),
    ).toMatchObject({ status: "PENDING" });
    expect(
      await client.auditEvent.count({
        where: { workspaceId, action: "workspace.invitation.accepted" },
      }),
    ).toBe(0);
  });
});
