import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { Niche } from "@money-maker/core/niches/niche";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const createFixture = (role: WorkspaceMembership["role"] = "operator"): ApiDependencies => {
  const created: Niche[] = [];
  return {
    invitation: {} as ApiDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () =>
        ({ workspaceId, userId, role, status: "active" }) satisfies WorkspaceMembership,
      addMembership: async () => undefined,
    },
    nicheRepository: {
      create: async (niche) => {
        created.push(niche);
        return niche;
      },
      listForWorkspace: async () => created,
      findForWorkspace: async () => null,
      updateState: async () => null,
    },
    authenticate: async () => ({ userId, verifiedEmail: "operator@example.com" }),
  };
};

describe("niche routes", () => {
  it("creates a workspace-scoped niche", async () => {
    const app = buildApp(createFixture());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/niches`,
      payload: {
        name: "Home office",
        audience: "Remote operators",
        problem: "Too many tools",
        editorialVoice: "Practical",
        languages: ["pt-BR"],
        monetizationHypothesis: "Affiliate offers",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().niche).toMatchObject({ name: "Home office", state: "draft" });
    await app.close();
  });

  it("does not allow reviewers to create a niche", async () => {
    const app = buildApp(createFixture("reviewer"));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/niches`,
      payload: {
        name: "Reviewer niche",
        audience: "Readers",
        problem: "A problem",
        editorialVoice: "Clear",
        languages: ["pt-BR"],
        monetizationHypothesis: "Affiliate offers",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
