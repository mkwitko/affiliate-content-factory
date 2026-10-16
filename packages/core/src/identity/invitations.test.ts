import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type MembershipRole } from "@money-maker/contracts";
import type { WorkspaceMembership } from "./authorization.js";

type InvitationStatus = "pending" | "accepted" | "revoked";
type InvitationRole = Exclude<MembershipRole, "owner">;

type Invitation = Readonly<{
  id: string;
  workspaceId: ReturnType<typeof parseWorkspaceId>;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  invitedBy: ReturnType<typeof parseUserId>;
  acceptedAt?: Date;
}>;

type MembershipRepository = {
  findByUserAndWorkspace: (input: {
    userId: ReturnType<typeof parseUserId>;
    workspaceId: ReturnType<typeof parseWorkspaceId>;
  }) => Promise<WorkspaceMembership | null>;
  ensureMembership: (input: {
    userId: ReturnType<typeof parseUserId>;
    workspaceId: ReturnType<typeof parseWorkspaceId>;
    role: InvitationRole;
  }) => Promise<"created" | "existing">;
};

type InvitationRepository = {
  create: (
    input: Omit<Invitation, "id" | "status" | "acceptedAt">,
    auditEvent: Omit<AuditEvent, "invitationId">,
  ) => Promise<Readonly<{ invitation: Invitation; auditId: string }>>;
  findByTokenHash: (input: { tokenHash: string }) => Promise<Invitation | null>;
  acceptPending: (input: {
    invitationId: string;
    acceptedAt: Date;
    userId: ReturnType<typeof parseUserId>;
    ensureMembership: () => Promise<"created" | "existing">;
    auditEvent: AuditEvent;
  }) => Promise<
    "accepted" | "already_accepted" | "already_used" | "expired" | "revoked" | "not_found"
  >;
};

type AuditEvent = Readonly<{
  action: "workspace.invitation.created" | "workspace.invitation.accepted";
  workspaceId: ReturnType<typeof parseWorkspaceId>;
  actorUserId: ReturnType<typeof parseUserId>;
  invitationId: string;
}>;

type Dependencies = {
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  audit: { record: (event: AuditEvent) => Promise<void> };
  clock: { now: () => Date };
  tokens: { generate: () => string };
  tokenHasher: { hash: (token: string) => Promise<string> };
};

type InvitationApi = {
  createInvitation?: (
    command: {
      actorId: ReturnType<typeof parseUserId>;
      workspaceId: ReturnType<typeof parseWorkspaceId>;
      email: string;
      role: InvitationRole;
      expiresAt: Date;
    },
    dependencies: Dependencies,
  ) => Promise<unknown>;
  acceptInvitation?: (
    command: {
      userId: ReturnType<typeof parseUserId>;
      email: string;
      token: string;
    },
    dependencies: Dependencies,
  ) => Promise<unknown>;
};

const ownerId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const invitedUserId = parseUserId("3158b518-4968-4777-80dd-1c61854d3a46");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-21T12:00:00.000Z");
const expiry = new Date("2026-09-28T12:00:00.000Z");

const loadApi = async (): Promise<InvitationApi> => {
  const createModule = (await import("./create-invitation.js").catch(() => ({}))) as InvitationApi;
  const acceptModule = (await import("./accept-invitation.js").catch(() => ({}))) as InvitationApi;

  return { ...createModule, ...acceptModule };
};

const createMembership = (overrides: Partial<WorkspaceMembership> = {}): WorkspaceMembership => ({
  userId: ownerId,
  workspaceId,
  role: "owner",
  status: "active",
  ...overrides,
});

const createDependencies = (overrides: Partial<Dependencies> = {}): Dependencies => {
  const membershipRepository: MembershipRepository = {
    findByUserAndWorkspace: async () => createMembership(),
    ensureMembership: async () => "created",
  };
  const invitationRepository: InvitationRepository = {
    create: async (input) => ({
      invitation: { id: "invitation-1", status: "pending", ...input },
      auditId: "audit-event-1",
    }),
    findByTokenHash: async () => null,
    acceptPending: async () => "accepted",
  };

  return {
    memberships: membershipRepository,
    invitations: invitationRepository,
    audit: { record: async () => undefined },
    clock: { now: () => now },
    tokens: { generate: () => "raw-token" },
    tokenHasher: { hash: async (token) => `hash:length:${token.length}` },
    ...overrides,
  };
};

describe("createInvitation", () => {
  it("allows an owner, stores only a token hash, returns the raw token once, and audits creation", async () => {
    const api = await loadApi();
    expect(api.createInvitation).toBeTypeOf("function");
    if (!api.createInvitation) return;

    const stored: Invitation[] = [];
    const events: AuditEvent[] = [];
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        create: async (input, auditEvent) => {
          const invitation = { id: "invitation-1", status: "pending" as const, ...input };
          events.push({ ...auditEvent, invitationId: invitation.id });
          stored.push(invitation);
          return { invitation, auditId: "audit-event-1" };
        },
      },
      audit: {
        record: async () => {
          throw new Error("Audit must be inside the repository transaction");
        },
      },
    });

    const result = await api.createInvitation(
      {
        actorId: ownerId,
        workspaceId,
        email: " Friend@Example.COM ",
        role: "operator",
        expiresAt: expiry,
      },
      dependencies,
    );

    expect(result).toEqual({
      ok: true,
      invitation: {
        id: "invitation-1",
        workspaceId,
        email: "friend@example.com",
        role: "operator",
        expiresAt: expiry,
      },
      token: "raw-token",
      auditId: "audit-event-1",
    });
    expect(stored[0]?.tokenHash).toBe("hash:length:9");
    expect(stored[0]?.tokenHash).not.toContain("raw-token");
    expect(events).toEqual([
      {
        action: "workspace.invitation.created",
        workspaceId,
        actorUserId: ownerId,
        invitationId: "invitation-1",
      },
    ]);
  });

  it("rejects a non-owner without generating, storing, or auditing an invitation", async () => {
    const api = await loadApi();
    expect(api.createInvitation).toBeTypeOf("function");
    if (!api.createInvitation) return;

    let generated = false;
    let created = false;
    let audited = false;
    const dependencies = createDependencies({
      memberships: {
        ...createDependencies().memberships,
        findByUserAndWorkspace: async () =>
          createMembership({ userId: invitedUserId, role: "reviewer" }),
      },
      tokens: {
        generate: () => {
          generated = true;
          return "raw-token";
        },
      },
      invitations: {
        ...createDependencies().invitations,
        create: async (input) => {
          created = true;
          return {
            invitation: { id: "invitation-1", status: "pending", ...input },
            auditId: "audit-event-1",
          };
        },
      },
      audit: {
        record: async () => {
          audited = true;
        },
      },
    });

    const result = await api.createInvitation(
      {
        actorId: invitedUserId,
        workspaceId,
        email: "friend@example.com",
        role: "operator",
        expiresAt: expiry,
      },
      dependencies,
    );

    expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN", message: "Access denied" } });
    expect(generated).toBe(false);
    expect(created).toBe(false);
    expect(audited).toBe(false);
  });
});

describe("acceptInvitation", () => {
  const pendingInvitation: Invitation = {
    id: "invitation-1",
    workspaceId,
    email: "friend@example.com",
    role: "operator",
    tokenHash: "hash:length:9",
    status: "pending",
    expiresAt: expiry,
    invitedBy: ownerId,
  };

  it("returns a stable not-found error for an unknown token", async () => {
    const api = await loadApi();
    expect(api.acceptInvitation).toBeTypeOf("function");
    if (!api.acceptInvitation) return;

    let accepted = false;
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => null,
        acceptPending: async () => {
          accepted = true;
          return "accepted";
        },
      },
    });

    const result = await api.acceptInvitation(
      { userId: invitedUserId, email: "friend@example.com", token: "unknown-token" },
      dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
    });
    expect(accepted).toBe(false);
  });

  it("accepts a valid invitation in one transaction and audits the acceptance", async () => {
    const api = await loadApi();
    expect(api.acceptInvitation).toBeTypeOf("function");
    if (!api.acceptInvitation) return;

    let ensured = 0;
    const events: AuditEvent[] = [];
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => pendingInvitation,
        acceptPending: async (input) => {
          const membershipResult = await input.ensureMembership();
          expect(membershipResult).toBe("created");
          events.push(input.auditEvent);
          return "accepted";
        },
      },
      memberships: {
        ...createDependencies().memberships,
        ensureMembership: async () => {
          ensured += 1;
          return "created";
        },
      },
      audit: {
        record: async () => {
          throw new Error("Audit must be inside the repository transaction");
        },
      },
    });

    const result = await api.acceptInvitation(
      { userId: invitedUserId, email: "FRIEND@example.com", token: "raw-token" },
      dependencies,
    );

    expect(result).toEqual({ ok: true, status: "accepted", invitationId: "invitation-1" });
    expect(ensured).toBe(1);
    expect(events).toEqual([
      {
        action: "workspace.invitation.accepted",
        workspaceId,
        actorUserId: invitedUserId,
        invitationId: "invitation-1",
      },
    ]);
  });

  it("maps expiry detected at the database write boundary without auditing success", async () => {
    const api = await loadApi();
    if (!api.acceptInvitation) throw new Error("Missing use case");
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => pendingInvitation,
        acceptPending: async () => "expired",
      },
      audit: {
        record: async () => {
          throw new Error("Expired invitations cannot be audited as accepted");
        },
      },
    });
    expect(
      await api.acceptInvitation(
        { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
        dependencies,
      ),
    ).toEqual({
      ok: false,
      error: { code: "INVITATION_EXPIRED", message: "Invitation has expired" },
    });
  });

  it.each([
    ["revocation", "revoked", "INVITATION_REVOKED"],
    ["deletion", "not_found", "INVITATION_NOT_FOUND"],
    ["another user's acceptance", "already_used", "INVITATION_ALREADY_USED"],
  ] as const)("maps %s detected at the database write boundary", async (_name, status, code) => {
    const api = await loadApi();
    if (!api.acceptInvitation) throw new Error("Missing use case");
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => pendingInvitation,
        acceptPending: async () => status,
      },
    });

    await expect(
      api.acceptInvitation(
        { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
        dependencies,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code, message: expect.any(String) },
    });
  });

  it.each([
    [
      "wrong email",
      { userId: invitedUserId, email: "other@example.com", token: "raw-token" },
      "INVITATION_EMAIL_MISMATCH",
    ],
    [
      "expired invitation",
      { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
      "INVITATION_EXPIRED",
    ],
    [
      "revoked invitation",
      { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
      "INVITATION_REVOKED",
    ],
  ] as const)("rejects %s without accepting", async (reason, command, code) => {
    const api = await loadApi();
    expect(api.acceptInvitation).toBeTypeOf("function");
    if (!api.acceptInvitation) return;

    let accepted = false;
    const invitation =
      reason === "expired invitation"
        ? { ...pendingInvitation, expiresAt: new Date("2026-09-20T12:00:00.000Z") }
        : reason === "revoked invitation"
          ? { ...pendingInvitation, status: "revoked" as const }
          : pendingInvitation;
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => invitation,
        acceptPending: async () => {
          accepted = true;
          return "accepted";
        },
      },
    });

    const result = await api.acceptInvitation(command, dependencies);

    expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
    expect(accepted).toBe(false);
  });

  it("does not duplicate membership when the same invitation is accepted twice", async () => {
    const api = await loadApi();
    expect(api.acceptInvitation).toBeTypeOf("function");
    if (!api.acceptInvitation) return;

    let acceptanceCount = 0;
    let membershipCount = 0;
    const dependencies = createDependencies({
      invitations: {
        ...createDependencies().invitations,
        findByTokenHash: async () => ({
          ...pendingInvitation,
          status: acceptanceCount > 0 ? ("accepted" as const) : ("pending" as const),
        }),
        acceptPending: async (input) => {
          acceptanceCount += 1;
          await input.ensureMembership();
          return "accepted";
        },
      },
      memberships: {
        ...createDependencies().memberships,
        ensureMembership: async () => {
          membershipCount += 1;
          return membershipCount === 1 ? "created" : "existing";
        },
      },
    });

    const first = await api.acceptInvitation(
      { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
      dependencies,
    );
    const second = await api.acceptInvitation(
      { userId: invitedUserId, email: "friend@example.com", token: "raw-token" },
      dependencies,
    );

    expect(first).toEqual({ ok: true, status: "accepted", invitationId: "invitation-1" });
    expect(second).toEqual({ ok: true, status: "already_accepted", invitationId: "invitation-1" });
    expect(acceptanceCount).toBe(1);
    expect(membershipCount).toBe(1);
  });
});
