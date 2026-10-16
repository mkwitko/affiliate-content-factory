import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Niche } from "../niches/niche.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import type { MarketplaceCatalog } from "../offers/marketplace-catalog.js";
import type { ProductCandidate } from "./product-candidate.js";
import type { ProductCandidateRepository } from "./product-candidate-repository.js";
import { createResearchPolicy, type ResearchPolicy } from "./research-policy.js";
import type { ResearchPolicyRepository } from "./research-policy-repository.js";
import { runDueResearchPolicies } from "./run-research-policies.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const nicheWithContext: Niche = {
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
  context: { pillars: ["cafeteira"], prioritize: ["portátil"], avoid: ["usada"] },
};

const fakePolicies = (
  initial: readonly ResearchPolicy[],
  options?: { claim?: (id: string) => boolean; recordRunResult?: (id: string) => void },
): ResearchPolicyRepository & {
  updated: ResearchPolicy[];
  claimed: string[];
  results: { id: string; lastError: string | null }[];
} => {
  const updated: ResearchPolicy[] = [];
  const claimed: string[] = [];
  const results: { id: string; lastError: string | null }[] = [];
  return {
    updated,
    claimed,
    results,
    create: async (policy) => policy,
    findForNiche: async () => null,
    listForWorkspace: async () => initial,
    update: async (policy) => {
      updated.push(policy);
      return policy;
    },
    listActiveDue: async () => initial,
    claimForRun: async (id) => {
      claimed.push(id);
      return options?.claim ? options.claim(id) : true;
    },
    claimForTopUp: async () => true,
    recordRunResult: async (id, lastError) => {
      options?.recordRunResult?.(id);
      results.push({ id, lastError });
    },
  };
};

const fakeNiches = (byId: Record<string, Niche>): Pick<NicheRepository, "findForWorkspace"> => ({
  findForWorkspace: async ({ nicheId }) => byId[nicheId] ?? null,
});

const unusedLifecycle = {
  findForWorkspace: async () => null,
  listByState: async () => [],
  countByState: async () => ({}) as never,
  transition: async () => null,
  findByOffer: async () => null,
};

const fakeCandidates = (): ProductCandidateRepository & { stored: ProductCandidate[] } => {
  const stored: ProductCandidate[] = [];
  return {
    stored,
    createMany: async (candidates) => {
      stored.push(...candidates);
    },
    listForNiche: async () => stored,
    ...unusedLifecycle,
  };
};

const candidate = (input: { providerId: string; title: string; priceMinor: number }) => ({
  providerId: input.providerId,
  title: input.title,
  listingUrl: new URL(`https://produto.mercadolivre.com.br/${input.providerId}`),
  seller: "Loja",
  availability: "available",
  listingStatus: "active" as const,
  currentPrice: { amountMinor: input.priceMinor, currency: "BRL" },
});

describe("runDueResearchPolicies", () => {
  it("skips a policy already run today (idempotent per policy+day) without claiming it", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const base = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const alreadyRanToday = { ...base, lastRunAt: new Date("2026-09-22T02:00:00Z") };
    let searchCalls = 0;
    const policies = fakePolicies([alreadyRanToday]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates: fakeCandidates(),
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => {
          searchCalls++;
          return [];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(searchCalls).toBe(0);
    expect(policies.claimed).toHaveLength(0);
    expect(policies.results).toHaveLength(0);
  });

  it("does not run a policy that loses the claim race (already paused/revoked/claimed elsewhere)", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    let searchCalls = 0;
    const policies = fakePolicies([policy], { claim: () => false });
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates: fakeCandidates(),
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => {
          searchCalls++;
          return [];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(policies.claimed).toEqual([policy.id]);
    expect(searchCalls).toBe(0);
    expect(policies.results).toHaveLength(0);
  });

  it("drops avoid-term and out-of-range items, ranks by prioritize matches then price, caps at maxCandidatesPerRun", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 2,
      priceMinMinor: 1000,
      priceMaxMinor: 20000,
      currency: "BRL",
    });
    const results = [
      candidate({ providerId: "1", title: "Cafeteira portátil usada", priceMinor: 5000 }), // avoid term
      candidate({ providerId: "2", title: "Cafeteira gigante", priceMinor: 100 }), // below price range
      candidate({ providerId: "3", title: "Cafeteira portátil nova", priceMinor: 15000 }), // matches prioritize
      candidate({ providerId: "4", title: "Cafeteira simples", priceMinor: 5000 }), // no prioritize match
      candidate({ providerId: "5", title: "Cafeteira portátil compacta", priceMinor: 8000 }), // matches prioritize, cheaper
    ];
    const candidates = fakeCandidates();
    const policies = fakePolicies([policy]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates,
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => results,
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(candidates.stored).toHaveLength(2);
    expect(candidates.stored.map((c) => c.providerId)).toEqual(["5", "3"]);
    expect(candidates.stored[0]).toMatchObject({ rank: 0 });
    expect(candidates.stored[1]).toMatchObject({ rank: 1 });
    expect(policies.claimed).toEqual([policy.id]);
    expect(policies.results).toEqual([{ id: policy.id, lastError: null }]);
  });

  it("puts best sellers first, keeps their rank, and still searches when the list is refused", async () => {
    const now = new Date("2026-10-15T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
      currency: "BRL",
    });
    const run = async (searchBestSellers: MarketplaceCatalog["searchBestSellers"]) => {
      const candidates = fakeCandidates();
      await runDueResearchPolicies({
        policies: fakePolicies([policy]),
        niches: fakeNiches({ "niche-1": nicheWithContext }),
        candidates,
        marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
          search: async () => [
            candidate({ providerId: "s", title: "Cafeteira simples", priceMinor: 1000 }),
            candidate({ providerId: "top", title: "Cafeteira elétrica", priceMinor: 9000 }),
          ],
          ...(searchBestSellers ? { searchBestSellers } : {}),
          readBuyerVoice: async () => {
            throw new Error("not_used");
          },
          readProductEvidence: async () => {
            throw new Error("unused");
          },
        }),
        now: () => now,
      });
      return candidates.stored;
    };
    const ranked = await run(async () => [
      {
        ...candidate({ providerId: "top", title: "Cafeteira elétrica", priceMinor: 9000 }),
        bestSellerRank: 3,
      },
    ]);
    expect(ranked.map((c) => [c.providerId, c.bestSellerRank])).toEqual([
      ["top", 3],
      ["s", undefined],
    ]);
    const refused = await run(async () => {
      throw new Error("unauthorized");
    });
    expect(refused.map((c) => c.providerId)).toEqual(["s", "top"]);
  });

  it("drops books and ranks equal prioritize matches by units sold before price", async () => {
    const now = new Date("2026-10-15T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
      currency: "BRL",
    });
    const results = [
      {
        ...candidate({ providerId: "b", title: "Livro (Organizador) Cafeteira", priceMinor: 1900 }),
        domainId: "MLB-BOOKS",
      },
      {
        ...candidate({ providerId: "cheap", title: "Cafeteira simples", priceMinor: 1000 }),
        soldQuantity: 5,
      },
      {
        ...candidate({ providerId: "popular", title: "Cafeteira elétrica", priceMinor: 9000 }),
        soldQuantity: 5000,
      },
    ];
    const candidates = fakeCandidates();
    await runDueResearchPolicies({
      policies: fakePolicies([policy]),
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates,
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => results,
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(candidates.stored.map((c) => c.providerId)).toEqual(["popular", "cheap"]);
  });

  it("records lastError and moves to the next policy on a connection failure, without throwing", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const failingPolicy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const otherWorkspaceId = parseWorkspaceId("585778f8-ab15-412a-8b65-d05a4d1bb186");
    const okPolicy = createResearchPolicy({
      workspaceId: otherWorkspaceId,
      nicheId: "niche-2",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const nicheTwo: Niche = { ...nicheWithContext, id: "niche-2", workspaceId: otherWorkspaceId };
    const candidates = fakeCandidates();
    const policies = fakePolicies([failingPolicy, okPolicy]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext, "niche-2": nicheTwo }),
      candidates,
      marketplaceCatalogForWorkspace: (ws): MarketplaceCatalog => ({
        search: async () => {
          if (ws === workspaceId) throw new Error("mercado_livre_not_connected");
          return [candidate({ providerId: "9", title: "Cafeteira portátil", priceMinor: 5000 })];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(policies.results).toHaveLength(2);
    expect(policies.results.find((r) => r.id === failingPolicy.id)).toMatchObject({
      lastError: "CONNECTION_UNAVAILABLE",
    });
    expect(policies.results.find((r) => r.id === okPolicy.id)).toMatchObject({
      lastError: null,
    });
    expect(candidates.stored).toHaveLength(1);
  });

  it("tolerates malformed niche.context fields (non-array) by treating them as empty", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    // Intentionally malformed to exercise the tolerance path: non-array context fields.
    const malformedNiche: Niche = {
      ...nicheWithContext,
      context: { pillars: "cafeteira", prioritize: 123, avoid: null } as never,
    };
    let searchCalls = 0;
    const policies = fakePolicies([policy]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": malformedNiche }),
      candidates: fakeCandidates(),
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => {
          searchCalls++;
          return [];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(searchCalls).toBe(0);
    expect(policies.results).toEqual([{ id: policy.id, lastError: "no_queries" }]);
  });

  it("records INTERNAL_ERROR (guarded) and continues on an unexpected error, without throwing", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const brokenPolicy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const otherWorkspaceId = parseWorkspaceId("585778f8-ab15-412a-8b65-d05a4d1bb186");
    const okPolicy = createResearchPolicy({
      workspaceId: otherWorkspaceId,
      nicheId: "niche-2",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const nicheTwo: Niche = { ...nicheWithContext, id: "niche-2", workspaceId: otherWorkspaceId };
    const candidates: ProductCandidateRepository & { stored: ProductCandidate[] } = {
      stored: [],
      createMany: async (items) => {
        if (items.some((item) => item.workspaceId === workspaceId)) {
          throw new Error("unexpected_db_failure");
        }
        candidates.stored.push(...items);
      },
      listForNiche: async () => candidates.stored,
      ...unusedLifecycle,
    };
    const policies = fakePolicies([brokenPolicy, okPolicy]);
    await expect(
      runDueResearchPolicies({
        policies,
        niches: fakeNiches({ "niche-1": nicheWithContext, "niche-2": nicheTwo }),
        candidates,
        marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
          search: async () => [
            candidate({ providerId: "1", title: "Cafeteira portátil", priceMinor: 5000 }),
          ],
          readBuyerVoice: async () => {
            throw new Error("not_used");
          },
          readProductEvidence: async () => {
            throw new Error("unused");
          },
        }),
        now: () => now,
      }),
    ).resolves.toBeUndefined();
    expect(policies.results.find((r) => r.id === brokenPolicy.id)).toMatchObject({
      lastError: "INTERNAL_ERROR",
    });
    expect(policies.results.find((r) => r.id === okPolicy.id)).toMatchObject({ lastError: null });
  });

  it("does not throw when recordRunResult itself fails (guarded) and still moves to the next policy", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const failingRecordPolicy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const otherWorkspaceId = parseWorkspaceId("585778f8-ab15-412a-8b65-d05a4d1bb186");
    const okPolicy = createResearchPolicy({
      workspaceId: otherWorkspaceId,
      nicheId: "niche-2",
      frequency: "daily",
      maxCandidatesPerRun: 5,
    });
    const nicheTwo: Niche = { ...nicheWithContext, id: "niche-2", workspaceId: otherWorkspaceId };
    const policies: ResearchPolicyRepository & { okResults: (string | null)[] } = {
      okResults: [],
      create: async (policy) => policy,
      findForNiche: async () => null,
      listForWorkspace: async () => [failingRecordPolicy, okPolicy],
      update: async (policy) => policy,
      listActiveDue: async () => [failingRecordPolicy, okPolicy],
      claimForRun: async () => true,
      claimForTopUp: async () => true,
      recordRunResult: async (id, lastError) => {
        if (id === failingRecordPolicy.id) throw new Error("db_unavailable");
        policies.okResults.push(lastError);
      },
    };
    await expect(
      runDueResearchPolicies({
        policies,
        niches: fakeNiches({ "niche-1": nicheWithContext, "niche-2": nicheTwo }),
        candidates: fakeCandidates(),
        marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
          search: async () => [],
          readBuyerVoice: async () => {
            throw new Error("not_used");
          },
          readProductEvidence: async () => {
            throw new Error("unused");
          },
        }),
        now: () => now,
      }),
    ).resolves.toBeUndefined();
    expect(policies.okResults).toEqual([null]);
  });

  it("runs Mercado Livre queries sequentially and caps them at 10 per run", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const explicitQueries = Array.from({ length: 15 }, (_, index) => `query-${index}`);
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
      explicitQueries,
    });
    const calls: string[] = [];
    const policies = fakePolicies([policy]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates: fakeCandidates(),
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async ({ query }) => {
          calls.push(query);
          return [];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(calls).toHaveLength(10);
    expect(calls).toEqual(explicitQueries.slice(0, 10));
  });

  it("stops issuing further queries on rate_limited and records it", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
      explicitQueries: ["a", "b", "c"],
    });
    let calls = 0;
    const policies = fakePolicies([policy]);
    await runDueResearchPolicies({
      policies,
      niches: fakeNiches({ "niche-1": nicheWithContext }),
      candidates: fakeCandidates(),
      marketplaceCatalogForWorkspace: (): MarketplaceCatalog => ({
        search: async () => {
          calls++;
          if (calls === 2) throw new Error("rate_limited");
          return [];
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("unused");
        },
      }),
      now: () => now,
    });
    expect(calls).toBe(2);
    expect(policies.results).toEqual([{ id: policy.id, lastError: "RATE_LIMITED" }]);
  });
});
