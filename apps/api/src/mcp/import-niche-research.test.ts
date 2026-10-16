import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type { ResearchSnapshot } from "@money-maker/core/research/research-snapshot";
import { createMcpServer } from "./server.js";
import { oauthScopes } from "../auth/oidc-token-verifier.js";
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const call = (server: ReturnType<typeof createMcpServer>, arguments_: unknown) =>
  server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "import_niche_research", arguments: arguments_ },
  });
const deps = (records: ResearchSnapshot[]): Parameters<typeof createMcpServer>[0] => {
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({ userId, workspaceId, role: "owner", status: "active" }),
    addMembership: async () => undefined,
  };
  const invitation = {
    memberships: {
      findByUserAndWorkspace: async () => ({
        userId,
        workspaceId,
        role: "owner",
        status: "active",
      }),
      ensureMembership: async () => "created",
    },
    invitations: {} as InvitationDependencies["invitations"],
    audit: { record: async () => "audit" },
    clock: { now: () => new Date() },
    tokens: { generate: () => "token" },
    tokenHasher: { hash: async () => "hash" },
  } as InvitationDependencies;
  const researchRepository: ResearchRepository = {
    create: async (snapshot) => {
      records.push(snapshot);
      return snapshot;
    },
    findByHash: async ({ hash }) =>
      records.find((snapshot) => snapshot.contentHash === hash) ?? null,
  };
  return {
    authenticate: async () => ({
      userId,
      verifiedEmail: "owner@example.com",
      scopes: new Set(oauthScopes),
    }),
    invitation,
    workspaces,
    researchRepository,
    audit: { record: async () => "audit" },
  };
};
describe("import_niche_research MCP tool", () => {
  it("stores and deduplicates attributable observations", async () => {
    const records: ResearchSnapshot[] = [];
    const server = createMcpServer(deps(records));
    const args = {
      workspaceId,
      provider: "vidiq",
      query: "cafeteira",
      locale: "pt-BR",
      observedAt: "2026-09-21T12:00:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z",
      observations: [
        { key: "keyword", value: "cafeteira portátil", sourceUrl: "https://vidiq.example/keyword" },
      ],
    };
    await call(server, args);
    const second = await call(server, args);
    expect(records).toHaveLength(1);
    expect(second.result?.structuredContent).toMatchObject({ deduplicated: true });
  });

  it("returns observation ids so scripts can cite them as evidence", async () => {
    const records: ResearchSnapshot[] = [];
    const server = createMcpServer(deps(records));
    const args = {
      workspaceId,
      provider: "manual",
      query: "why milk is at the back",
      locale: "en-US",
      observedAt: "2026-09-21T12:00:00.000Z",
      expiresAt: "2027-09-21T12:00:00.000Z",
      observations: [
        {
          key: "dairy_placement",
          value: "Dairy sits by the back cold room.",
          sourceUrl: "https://example.org/a",
        },
      ],
    };
    const first = await call(server, args);
    const second = await call(server, args);
    const id = records[0]?.observations[0]?.id;
    for (const response of [first, second])
      expect(response.result?.structuredContent).toMatchObject({
        observations: [{ id, key: "dairy_placement", sourceUrl: "https://example.org/a" }],
      });
  });

  it("accepts an optional nicheId that belongs to the caller's workspace", async () => {
    const records: ResearchSnapshot[] = [];
    const nicheRepository = {
      listForWorkspace: async () => [],
      create: async (niche: never) => niche,
      findForWorkspace: async ({ nicheId }: { nicheId: string }) =>
        nicheId === "niche-1"
          ? {
              id: "niche-1",
              workspaceId,
              name: "n",
              audience: "a",
              problem: "p",
              editorialVoice: "v",
              languages: ["pt-BR"],
              monetizationHypothesis: "m",
              state: "active" as const,
              kind: "affiliate" as const,
            }
          : null,
      updateState: async () => null,
    };
    const server = createMcpServer({ ...deps(records), nicheRepository });
    const response = await call(server, {
      workspaceId,
      provider: "manual",
      nicheId: "niche-1",
      query: "cafeteira",
      locale: "pt-BR",
      observedAt: "2026-09-21T12:00:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z",
      observations: [{ key: "keyword", value: "cafeteira", sourceUrl: "https://vidiq.example/x" }],
    });
    expect(records[0]?.nicheId).toBe("niche-1");
    expect(response.result?.isError).not.toBe(true);
  });

  it("does not deduplicate identical observations imported for a different niche", async () => {
    const records: ResearchSnapshot[] = [];
    const nicheRepository = {
      listForWorkspace: async () => [],
      create: async (niche: never) => niche,
      findForWorkspace: async ({ nicheId }: { nicheId: string }) =>
        nicheId === "niche-1"
          ? {
              id: "niche-1",
              workspaceId,
              name: "n",
              audience: "a",
              problem: "p",
              editorialVoice: "v",
              languages: ["pt-BR"],
              monetizationHypothesis: "m",
              state: "active" as const,
              kind: "affiliate" as const,
            }
          : null,
      updateState: async () => null,
    };
    const server = createMcpServer({ ...deps(records), nicheRepository });
    const args = {
      workspaceId,
      provider: "manual",
      query: "cafeteira",
      locale: "pt-BR",
      observedAt: "2026-09-21T12:00:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z",
      observations: [{ key: "keyword", value: "cafeteira", sourceUrl: "https://vidiq.example/x" }],
    };
    await call(server, args);
    const second = await call(server, { ...args, nicheId: "niche-1" });

    expect(records).toHaveLength(2);
    expect(records[1]?.nicheId).toBe("niche-1");
    expect(second.result?.structuredContent).toMatchObject({ deduplicated: false });
  });

  it("rejects a nicheId that does not belong to the caller's workspace", async () => {
    const records: ResearchSnapshot[] = [];
    const nicheRepository = {
      listForWorkspace: async () => [],
      create: async (niche: never) => niche,
      findForWorkspace: async () => null,
      updateState: async () => null,
    };
    const server = createMcpServer({ ...deps(records), nicheRepository });
    const response = await call(server, {
      workspaceId,
      provider: "manual",
      nicheId: "someone-elses-niche",
      query: "cafeteira",
      locale: "pt-BR",
      observedAt: "2026-09-21T12:00:00.000Z",
      expiresAt: "2026-09-28T12:00:00.000Z",
      observations: [{ key: "keyword", value: "cafeteira", sourceUrl: "https://vidiq.example/x" }],
    });
    expect(response.result?.isError).toBe(true);
    expect(records).toHaveLength(0);
  });
});
