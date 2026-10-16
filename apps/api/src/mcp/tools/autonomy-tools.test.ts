import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { createResearchPolicy } from "@money-maker/core/research/research-policy";
import type { McpDependencies } from "../server.js";
import { fakeCandidateRepository } from "./candidate-repository-fake.js";
import { getAutonomyStatusTool } from "./get-autonomy-status.js";
import { listHumanActionsTool } from "./list-human-actions.js";
import { runAutonomyCycleTool } from "./run-autonomy-cycle.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("c3b0e04a-0eb7-43d8-89c5-b7db207a7237");

const niche: Niche = {
  id: "niche-1",
  workspaceId,
  name: "Casa",
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["pt-BR"],
  monetizationHypothesis: "h",
  state: "active",
  kind: "affiliate",
};

const row = (id: string): ProductCandidate => ({
  id,
  workspaceId,
  nicheId: "niche-1",
  policyId: "policy-1",
  providerId: `MLB${id}`,
  title: `Produto ${id}`,
  listingUrl: `https://www.mercadolivre.com.br/p/MLB${id}`,
  seller: "Loja",
  availability: "available",
  priceMinor: 9990,
  currency: "BRL",
  rank: 0,
  discoveredAt: new Date(),
  state: "discovered",
});

const deps = (role: "owner" | "operator" | "reviewer" = "operator"): McpDependencies => {
  const policy = createResearchPolicy({
    workspaceId,
    nicheId: "niche-1",
    frequency: "daily",
    maxCandidatesPerRun: 5,
    targetPendingLinks: 2,
  });
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "W" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
    findMembership: async ({ workspaceId: id }) =>
      id === workspaceId ? { workspaceId, userId: actorId, role, status: "active" } : null,
    addMembership: async () => undefined,
  };
  const enqueued = new Map<string, unknown>();
  return {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces,
    nicheRepository: {
      create: async (value: Niche) => value,
      listForWorkspace: async () => [niche],
      findForWorkspace: async () => niche,
    } as never,
    researchPolicyRepository: {
      listForWorkspace: async () => [policy],
      listActiveDue: async () => [policy],
      claimForTopUp: async () => true,
      recordRunResult: async () => undefined,
    } as never,
    productCandidateRepository: fakeCandidateRepository([row("a"), row("b"), row("c")]),
    offerRepository: {
      listForWorkspace: async () => [],
      findForWorkspace: async () => null,
    } as never,
    productPostingHistoryRepository: { productPostingHistory: async () => [] },
    contentRepository: {
      listVariantsForWorkspace: async () => [],
      findContentItemForWorkspace: async () => null,
    } as never,
    publicationAttempts: { listLatestForVariants: async () => new Map() } as never,
    assetRepository: { listForWorkspace: async () => [] } as never,
    jobQueue: {
      enqueue: async (job: { idempotencyKey: string }) => {
        enqueued.set(job.idempotencyKey, job);
        return {} as never;
      },
    } as never,
    jobStats: { countByStatus: async () => [], listFailed: async () => [] },
    marketplaceCatalogForWorkspace: () =>
      ({
        readProductEvidence: async (providerId: string) => ({
          providerId,
          title: "Panela",
          listingUrl: new URL("https://www.mercadolivre.com.br/p/x"),
          seller: "Loja",
          availability: "available",
          listingStatus: "active",
          currentPrice: { amountMinor: 9990, currency: "BRL" },
          observedAt: new Date(),
          ratingAverage: 4.8,
          reviewCount: 80,
        }),
        readBuyerVoice: async () => {
          throw new Error("voice_down");
        },
        search: async () => [],
      }) as never,
    generationPolicy: "local_first",
    autonomyEnabled: true,
  };
};

describe("autonomy tools", () => {
  it("lets a reviewer read status and human actions but not run the cycle", async () => {
    const reviewer = deps("reviewer");
    const status = await getAutonomyStatusTool({ workspaceId }, actorId, reviewer);
    expect(status).toMatchObject({
      ok: true,
      value: { generationPolicy: "local_first", autonomyEnabled: true },
    });
    const actions = await listHumanActionsTool({ workspaceId }, actorId, reviewer);
    expect(actions.ok).toBe(true);
    const run = await runAutonomyCycleTool({ workspaceId }, actorId, reviewer);
    expect(run.ok).toBe(false);
  });

  it("denies other workspaces and bad arguments", async () => {
    expect(
      (await runAutonomyCycleTool({ workspaceId: otherWorkspaceId }, actorId, deps())).ok,
    ).toBe(false);
    expect((await listHumanActionsTool({ workspaceId, extra: 1 }, actorId, deps())).ok).toBe(false);
  });

  it("runs the cycle, surfaces human actions, and a second run changes nothing", async () => {
    const operator = deps("operator");
    const first = await runAutonomyCycleTool({ workspaceId }, actorId, operator);
    expect(first).toMatchObject({ ok: true, value: { qualified: 2, errors: [] } });
    const listed = await listHumanActionsTool({ workspaceId }, actorId, operator);
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error("unexpected");
    const actions = (listed.value as { actions: { kind: string; refs: { candidateId: string } }[] })
      .actions;
    expect(actions.map((action) => action.kind)).toEqual(["affiliate_link", "affiliate_link"]);
    const second = await runAutonomyCycleTool({ workspaceId }, actorId, operator);
    expect(second).toMatchObject({
      ok: true,
      value: {
        expired: 0,
        qualified: 0,
        rejected: 0,
        duplicates: 0,
        discoveredRuns: 0,
        providerReads: 0,
        packageJobsEnqueued: 0,
        consumed: 0,
        errors: [],
      },
    });
  });
});
