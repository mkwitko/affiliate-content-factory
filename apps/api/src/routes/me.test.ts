import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceA = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const workspaceB = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const createFixture = (authenticated = true): ApiDependencies => ({
  invitation: {} as ApiDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceA, name: "Alpha" }),
    findByIdForMember: async () => null,
    findMembership: async () => null,
    listForMember: async () => [
      { id: workspaceA, name: "Alpha", role: "operator" as const },
      { id: workspaceB, name: "Beta", role: "reviewer" as const },
    ],
    addMembership: async () => undefined,
  } as ApiDependencies["workspaces"],
  authenticate: async () => (authenticated ? { userId, verifiedEmail: "owner@example.com" } : null),
});

describe("me routes", () => {
  it("returns only active workspace memberships", async () => {
    const app = buildApp(createFixture());
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/v1/me/workspaces" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaces: [
        { id: workspaceA, name: "Alpha", role: "operator" },
        { id: workspaceB, name: "Beta", role: "reviewer" },
      ],
    });
    await app.close();
  });

  it("does not disclose memberships without authentication", async () => {
    const app = buildApp(createFixture(false));
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/v1/me/workspaces" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
