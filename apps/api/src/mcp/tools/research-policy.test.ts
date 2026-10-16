import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ResearchPolicy } from "@money-maker/core/research/research-policy";
import type { ResearchPolicyRepository } from "@money-maker/core/research/research-policy-repository";
import type { McpDependencies } from "../server.js";
import { createResearchPolicyTool } from "./create-research-policy.js";
import { getResearchPolicyTool } from "./get-research-policy.js";
import { pauseResearchPolicyTool } from "./pause-research-policy.js";
import { revokeResearchPolicyTool } from "./revoke-research-policy.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("585778f8-ab15-412a-8b65-d05a4d1bb186");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
};

const baseNiche: Niche = {
  id: "niche-1",
  workspaceId,
  name: "Cafeteiras portáteis",
  audience: "Viajantes",
  problem: "Café ruim em viagem",
  editorialVoice: "Direto",
  languages: ["pt-BR"],
  monetizationHypothesis: "Afiliados",
  state: "active",
  kind: "affiliate",
};

const nicheRepository: NicheRepository = {
  create: async (value) => value,
  listForWorkspace: async () => [baseNiche],
  findForWorkspace: async ({ workspaceId: ws, nicheId }) =>
    ws === workspaceId && nicheId === baseNiche.id ? baseNiche : null,
  updateState: async () => null,
};

const inMemoryPolicies = (): ResearchPolicyRepository => {
  const store = new Map<string, ResearchPolicy>();
  const key = (ws: string, nicheId: string) => `${ws}:${nicheId}`;
  return {
    create: async (policy) => {
      store.set(key(policy.workspaceId, policy.nicheId), policy);
      return policy;
    },
    findForNiche: async ({ workspaceId: ws, nicheId }) => store.get(key(ws, nicheId)) ?? null,
    listForWorkspace: async (ws) =>
      [...store.values()].filter((policy) => policy.workspaceId === ws),
    update: async (policy) => {
      store.set(key(policy.workspaceId, policy.nicheId), policy);
      return policy;
    },
    listActiveDue: async () => [...store.values()].filter((policy) => policy.status === "active"),
    claimForRun: async (id, now) => {
      const policy = [...store.values()].find((candidate) => candidate.id === id);
      if (policy?.status !== "active") return false;
      store.set(key(policy.workspaceId, policy.nicheId), { ...policy, lastRunAt: now });
      return true;
    },
    claimForTopUp: async () => true,
    recordRunResult: async (id, lastError) => {
      const policy = [...store.values()].find((candidate) => candidate.id === id);
      if (policy?.status !== "active") return;
      store.set(key(policy.workspaceId, policy.nicheId), { ...policy, lastError });
    },
  };
};

const dependencies = (researchPolicyRepository: ResearchPolicyRepository): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces,
  nicheRepository,
  researchPolicyRepository,
});

describe("research policy MCP tools", () => {
  it("creates an active policy", async () => {
    const result = await createResearchPolicyTool(
      { workspaceId, nicheId: "niche-1", frequency: "daily", maxCandidatesPerRun: 10 },
      actorId,
      dependencies(inMemoryPolicies()),
    );
    expect(result).toMatchObject({ ok: true, value: { policy: { status: "active", version: 1 } } });
  });

  it("rejects maxCandidatesPerRun above 20 at the boundary", async () => {
    const result = await createResearchPolicyTool(
      { workspaceId, nicheId: "niche-1", frequency: "daily", maxCandidatesPerRun: 25 },
      actorId,
      dependencies(inMemoryPolicies()),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects a nicheId that belongs to a different workspace", async () => {
    const result = await createResearchPolicyTool(
      {
        workspaceId: otherWorkspaceId,
        nicheId: "niche-1",
        frequency: "daily",
        maxCandidatesPerRun: 5,
      },
      actorId,
      {
        authenticate: async () => ({ userId: actorId }),
        invitation: {} as McpDependencies["invitation"],
        workspaces: {
          ...workspaces,
          findByIdForMember: async () => ({ id: otherWorkspaceId, name: "Other" }),
          findMembership: async () => ({
            workspaceId: otherWorkspaceId,
            userId: actorId,
            role: "owner",
            status: "active",
          }),
        },
        nicheRepository,
        researchPolicyRepository: inMemoryPolicies(),
      },
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("accepts targetPendingLinks and rejects values above 20", async () => {
    const deps = dependencies(inMemoryPolicies());
    const base = { workspaceId, nicheId: "niche-1", frequency: "daily", maxCandidatesPerRun: 5 };
    const ok = await createResearchPolicyTool({ ...base, targetPendingLinks: 8 }, actorId, deps);
    expect(ok).toMatchObject({ ok: true, value: { policy: { targetPendingLinks: 8 } } });
    const bad = await createResearchPolicyTool({ ...base, targetPendingLinks: 21 }, actorId, deps);
    expect(bad).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("gets a single policy by nicheId, and lists when nicheId is omitted", async () => {
    const policies = inMemoryPolicies();
    const deps = dependencies(policies);
    await createResearchPolicyTool(
      { workspaceId, nicheId: "niche-1", frequency: "weekly", maxCandidatesPerRun: 5 },
      actorId,
      deps,
    );

    const single = await getResearchPolicyTool({ workspaceId, nicheId: "niche-1" }, actorId, deps);
    expect(single).toMatchObject({ ok: true, value: { policy: { nicheId: "niche-1" } } });

    const list = await getResearchPolicyTool({ workspaceId }, actorId, deps);
    if (!list.ok) throw new Error("expected ok result");
    expect(list.value.policies).toHaveLength(1);
  });

  it("pauses and revokes an existing policy, bumping its version", async () => {
    const policies = inMemoryPolicies();
    const deps = dependencies(policies);
    await createResearchPolicyTool(
      { workspaceId, nicheId: "niche-1", frequency: "daily", maxCandidatesPerRun: 5 },
      actorId,
      deps,
    );

    const paused = await pauseResearchPolicyTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      deps,
    );
    expect(paused).toMatchObject({ ok: true, value: { policy: { status: "paused", version: 2 } } });

    const revoked = await revokeResearchPolicyTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      deps,
    );
    expect(revoked).toMatchObject({
      ok: true,
      value: { policy: { status: "revoked", version: 3 } },
    });
  });

  it("returns NOT_FOUND when pausing a policy that does not exist", async () => {
    const result = await pauseResearchPolicyTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      dependencies(inMemoryPolicies()),
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
