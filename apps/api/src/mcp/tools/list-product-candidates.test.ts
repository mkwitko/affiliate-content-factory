import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import type { ProductCandidateRepository } from "@money-maker/core/research/product-candidate-repository";
import type { ProductPostingHistoryRepository } from "@money-maker/core/offers/product-posting-history";
import type { McpDependencies } from "../server.js";
import { fakeCandidateRepository } from "./candidate-repository-fake.js";
import { listProductCandidatesTool } from "./list-product-candidates.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

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

const candidate: ProductCandidate = {
  id: "candidate-1",
  workspaceId,
  nicheId: "niche-1",
  policyId: "policy-1",
  providerId: "ML1",
  title: "Cafeteira portátil",
  listingUrl: "https://produto.mercadolivre.com.br/ML1",
  seller: "Loja",
  availability: "available",
  priceMinor: 10000,
  currency: "BRL",
  rank: 0,
  discoveredAt: new Date("2026-09-22T00:00:00Z"),
  state: "discovered",
};

const noHistory: ProductPostingHistoryRepository = {
  productPostingHistory: async () => [],
};

const dependencies = (
  productCandidateRepository: ProductCandidateRepository,
  productPostingHistoryRepository: ProductPostingHistoryRepository = noHistory,
): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces,
  nicheRepository,
  productCandidateRepository,
  productPostingHistoryRepository,
});

describe("list_product_candidates", () => {
  it("lists stored candidates for a niche, never posted", async () => {
    const result = await listProductCandidatesTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      dependencies({ ...fakeCandidateRepository(), listForNiche: async () => [candidate] }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        candidates: [{ providerId: "ML1", lastPostedAt: null, postedCount: 0, inCooldown: false }],
        affiliateLinkBuilderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
      },
    });
  });

  it("annotates a candidate still in cooldown from an earlier post", async () => {
    const lastPublishedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const result = await listProductCandidatesTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      dependencies(
        { ...fakeCandidateRepository(), listForNiche: async () => [candidate] },
        {
          productPostingHistory: async () => [
            {
              productId: "ML1",
              offerTitle: "Cafeteira portátil",
              lastPublishedAt,
              publishedCount: 2,
              channels: ["instagram_carousel"],
            },
          ],
        },
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        candidates: [
          {
            providerId: "ML1",
            lastPostedAt: lastPublishedAt.toISOString(),
            postedCount: 2,
            inCooldown: true,
          },
        ],
      },
    });
  });

  it("rejects a nicheId that belongs to a different workspace", async () => {
    const result = await listProductCandidatesTool(
      { workspaceId, nicheId: "missing" },
      actorId,
      dependencies(fakeCandidateRepository()),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
