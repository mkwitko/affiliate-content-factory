import { describe, expect, it } from "vitest";

type IdentifierApi = {
  parseUserId?: (input: unknown) => string;
  parseWorkspaceId?: (input: unknown) => string;
};

type Membership = {
  userId: string;
  workspaceId: string;
  role: "owner" | "operator" | "reviewer";
  status: "active" | "revoked";
};

type AuthorizationApi = {
  authorizeWorkspace?: (input: {
    actorId: string;
    workspaceId: string;
    membership: Membership | null;
    allowedRoles: readonly Membership["role"][];
  }) => unknown;
};

const ownerId = "033bffd2-d9fb-4795-841d-6d83193a7707";
const otherUserId = "3158b518-4968-4777-80dd-1c61854d3a46";
const workspaceId = "0d7702aa-a69d-4f49-842a-c1a13e72160d";
const otherWorkspaceId = "99fb7f2f-7fe2-4140-88bb-08a5b16206a1";

const loadApis = async () => {
  const identifiers = (await import("@money-maker/contracts").catch(
    () => ({}) as IdentifierApi,
  )) as IdentifierApi;
  const authorization = (await import("./authorization.js").catch(
    () => ({}) as AuthorizationApi,
  )) as AuthorizationApi;

  expect(identifiers.parseUserId).toBeTypeOf("function");
  expect(identifiers.parseWorkspaceId).toBeTypeOf("function");
  expect(authorization.authorizeWorkspace).toBeTypeOf("function");

  return { ...identifiers, ...authorization };
};

const activeOwner: Membership = {
  userId: ownerId,
  workspaceId,
  role: "owner",
  status: "active",
};

const forbidden = {
  ok: false,
  error: { code: "FORBIDDEN", message: "Access denied" },
};

describe("identifiers", () => {
  it("parses valid user and workspace UUIDs", async () => {
    const { parseUserId, parseWorkspaceId } = await loadApis();
    if (!parseUserId || !parseWorkspaceId) return;

    expect(parseUserId(ownerId)).toBe(ownerId);
    expect(parseWorkspaceId(workspaceId)).toBe(workspaceId);
  });

  it("rejects invalid identifiers", async () => {
    const { parseUserId, parseWorkspaceId } = await loadApis();
    if (!parseUserId || !parseWorkspaceId) return;

    expect(() => parseUserId("user-1")).toThrow(/UserId/);
    expect(() => parseWorkspaceId("workspace-1")).toThrow(/WorkspaceId/);
  });
});

describe("authorizeWorkspace", () => {
  it("returns context for an active member with an allowed role", async () => {
    const { authorizeWorkspace } = await loadApis();
    if (!authorizeWorkspace) return;

    expect(
      authorizeWorkspace({
        actorId: ownerId,
        workspaceId,
        membership: activeOwner,
        allowedRoles: ["owner"],
      }),
    ).toEqual({
      ok: true,
      context: { userId: ownerId, workspaceId, role: "owner" },
    });
  });

  it.each([
    ["missing membership", null],
    ["revoked membership", { ...activeOwner, status: "revoked" as const }],
    ["another user", { ...activeOwner, userId: otherUserId }],
    ["another workspace", { ...activeOwner, workspaceId: otherWorkspaceId }],
  ])("returns the same denial for %s", async (_case, membership) => {
    const { authorizeWorkspace } = await loadApis();
    if (!authorizeWorkspace) return;

    expect(
      authorizeWorkspace({
        actorId: ownerId,
        workspaceId,
        membership,
        allowedRoles: ["owner"],
      }),
    ).toEqual(forbidden);
  });

  it("returns the same denial for an insufficient role", async () => {
    const { authorizeWorkspace } = await loadApis();
    if (!authorizeWorkspace) return;

    expect(
      authorizeWorkspace({
        actorId: ownerId,
        workspaceId,
        membership: { ...activeOwner, role: "reviewer" },
        allowedRoles: ["owner", "operator"],
      }),
    ).toEqual(forbidden);
  });
});
