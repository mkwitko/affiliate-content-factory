import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type {
  CandidateQualification,
  ProductCandidate,
} from "@money-maker/core/research/product-candidate";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { fakeCandidateRepository } from "./candidate-repository-fake.js";
import { listAffiliateLinkQueueTool } from "./list-affiliate-link-queue.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("c3b0e04a-0eb7-43d8-89c5-b7db207a7237");

const workspaces = (role: "owner" | "operator" | "reviewer" = "operator"): WorkspaceRepository => ({
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async ({ workspaceId: ws }) =>
    ws === workspaceId ? { workspaceId, userId: actorId, role, status: "active" } : null,
  addMembership: async () => undefined,
});

const niche = (id: string, name: string): Niche => ({
  id,
  workspaceId,
  name,
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["pt-BR"],
  monetizationHypothesis: "h",
  state: "active",
  kind: "affiliate",
});
const niches = [niche("niche-1", "Cafe"), niche("niche-2", "Casa")];
const nicheRepository: NicheRepository = {
  create: async (value: Niche) => value,
  listForWorkspace: async () => niches,
  findForWorkspace: async ({ nicheId }: { nicheId: string }) =>
    niches.find((n) => n.id === nicheId) ?? null,
} as unknown as NicheRepository;

const qualification = (score: number): CandidateQualification => ({
  version: 1,
  facts: {
    rating: 4.5,
    reviewCount: 50,
    soldQuantity: 100,
    listPriceMinor: null,
    freeShipping: true,
    observedAt: "2026-10-02T00:00:00.000Z",
  },
  heuristic: { score, parts: {} },
  hypotheses: ["angle: demonstration"],
  buyerVoice: null,
  reasons: ["good"],
});

const candidate = (id: string, overrides: Partial<ProductCandidate> = {}): ProductCandidate => ({
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
  discoveredAt: new Date("2026-10-02T00:00:00Z"),
  state: "awaiting_affiliate_link",
  qualifiedAt: new Date("2026-10-02T01:00:00Z"),
  qualification: qualification(10),
  ...overrides,
});

const deps = (
  rows: readonly ProductCandidate[],
  role: Parameters<typeof workspaces>[0] = "operator",
): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: workspaces(role),
  nicheRepository,
  productCandidateRepository: fakeCandidateRepository(rows),
});

describe("list_affiliate_link_queue", () => {
  it("returns only awaiting rows, best score first, with niche names", async () => {
    const result = await listAffiliateLinkQueueTool(
      { workspaceId },
      actorId,
      deps([
        candidate("1", { qualification: qualification(10) }),
        candidate("2", { qualification: qualification(90), nicheId: "niche-2" }),
        candidate("3", { state: "linked" }),
        candidate("4", { state: "discovered" }),
        candidate("5", { workspaceId: otherWorkspaceId }),
      ]),
    );
    if (!result.ok) throw new Error("expected ok");
    const value = result.value as {
      total: number;
      items: Record<string, unknown>[];
      instructions: string;
    };
    expect(value.total).toBe(2);
    expect(value.items.map((item) => item.candidateId)).toEqual(["2", "1"]);
    expect(value.items[0]).toMatchObject({
      nicheName: "Casa",
      providerId: "MLB2",
      score: 90,
      reasons: ["good"],
      hypotheses: ["angle: demonstration"],
      affiliateLinkBuilderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    });
    expect(value.instructions).toContain("submit_affiliate_links");
  });

  it("filters by niche and honors the limit", async () => {
    const rows = [candidate("1"), candidate("2", { nicheId: "niche-2" }), candidate("3")];
    const filtered = await listAffiliateLinkQueueTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      deps(rows),
    );
    expect(filtered).toMatchObject({ ok: true, value: { total: 2 } });
    const limited = await listAffiliateLinkQueueTool(
      { workspaceId, limit: 1 },
      actorId,
      deps(rows),
    );
    if (!limited.ok) throw new Error("expected ok");
    expect((limited.value as { items: unknown[] }).items).toHaveLength(1);
  });

  it("does not leak lifecycle ids or secrets", async () => {
    const result = await listAffiliateLinkQueueTool(
      { workspaceId },
      actorId,
      deps([candidate("1", { offerId: "offer-1" })]),
    );
    if (!result.ok) throw new Error("expected ok");
    const [item] = (result.value as { items: Record<string, unknown>[] }).items;
    expect(item).not.toHaveProperty("offerId");
    expect(item).not.toHaveProperty("workspaceId");
    expect(item).not.toHaveProperty("affiliateUrl");
  });

  it("allows reviewers and rejects invalid input", async () => {
    expect(
      (await listAffiliateLinkQueueTool({ workspaceId }, actorId, deps([], "reviewer"))).ok,
    ).toBe(true);
    expect(await listAffiliateLinkQueueTool({ workspaceId, limit: 51 }, actorId, deps([]))).toEqual(
      {
        ok: false,
        error: "INVALID_ARGUMENTS",
      },
    );
  });

  it("denies a workspace the actor is not a member of", async () => {
    const result = await listAffiliateLinkQueueTool(
      { workspaceId: otherWorkspaceId },
      actorId,
      deps([]),
    );
    expect(result.ok).toBe(false);
  });
});
