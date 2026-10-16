import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const jobId = "581e5ee1-eeb7-4b18-82b1-f5ae1d50fb13";
const stuckId = "5013d119-2b89-46d0-8ede-2c74214ee432";

const setup = (role: "owner" | "operator" | "reviewer", authenticated = true) => {
  const audited: unknown[] = [];
  const app = buildApp({
    invitation: {} as InvitationDependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({ workspaceId, userId, role, status: "active" }),
      addMembership: async () => undefined,
    },
    audit: {
      record: async (event: unknown) => {
        audited.push(event);
        return "a";
      },
    },
    jobStats: {
      listFailed: async () => [
        {
          id: jobId,
          name: "render_creatives",
          idempotencyKey: "k",
          terminalReason: "attempts_exhausted",
          updatedAt: new Date(),
          attemptCount: 2,
          identifiers: { contentItemId: "c1" },
        },
        {
          id: stuckId,
          name: "publish_content",
          idempotencyKey: "k2",
          terminalReason: "x",
          updatedAt: new Date(),
          attemptCount: 3,
        },
      ],
    },
    jobQueue: { revive: async () => true },
    contentRepository: { findContentItemForWorkspace: async () => ({ title: "Panela" }) },
    offerRepository: {},
    authenticate: async () => (authenticated ? { userId } : null),
  } as unknown as ApiDependencies);
  return { app, audited };
};

const base = `/v1/workspaces/${workspaceId}/failed-jobs`;

describe("failed job routes", () => {
  it("lists retryable jobs with titles for a reviewer", async () => {
    const response = await setup("reviewer").app.inject({ method: "GET", url: base });
    expect(response.statusCode).toBe(200);
    expect(response.json().jobs).toEqual([
      expect.objectContaining({ jobId, title: "Panela", contentItemId: "c1" }),
    ]);
  });

  it("retries a failed package step and audits it", async () => {
    const { app, audited } = setup("operator");
    const response = await app.inject({ method: "POST", url: `${base}/${jobId}/retry` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ retried: true });
    expect(audited).toEqual([expect.objectContaining({ action: "job.retried" })]);
  });

  it("answers 404 for an unknown job and 409 for a non-package job", async () => {
    const { app } = setup("owner");
    const unknown = "ab19183a-403e-4704-8351-5ba43b20423d";
    expect((await app.inject({ method: "POST", url: `${base}/${unknown}/retry` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "POST", url: `${base}/${stuckId}/retry` })).statusCode).toBe(
      409,
    );
  });

  it("requires authentication and forbids reviewers from retrying", async () => {
    expect(
      (await setup("owner", false).app.inject({ method: "POST", url: `${base}/${jobId}/retry` }))
        .statusCode,
    ).toBe(401);
    expect(
      (await setup("reviewer").app.inject({ method: "POST", url: `${base}/${jobId}/retry` }))
        .statusCode,
    ).toBe(403);
  });
});
