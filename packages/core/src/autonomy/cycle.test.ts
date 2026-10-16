import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { uuidFromKey } from "../content/offer-package.js";
import type { EnqueueJobInput } from "../jobs/job.js";
import type { Niche } from "../niches/niche.js";
import type {
  BuyerVoice,
  MarketplaceCatalog,
  ProductEvidence,
} from "../offers/marketplace-catalog.js";
import type { Offer } from "../offers/offer.js";
import type { ProductCandidate } from "../research/product-candidate.js";
import { createResearchPolicy, type ResearchPolicy } from "../research/research-policy.js";
import { type AutonomyCycleDeps, runAutonomyCycle } from "./cycle.js";
import { fakeCandidateRepository } from "./test-support.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const DAY = 86_400_000;
const offerId = "11111111-1111-4111-8111-111111111111";

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
  context: { prioritize: ["inox"], pillars: ["panela"] },
};

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
  discoveredAt: ago(DAY),
  state: "discovered",
  ...overrides,
});

const evidence = (
  providerId: string,
  overrides: Partial<ProductEvidence> = {},
): ProductEvidence => ({
  providerId,
  title: "Panela inox",
  listingUrl: new URL(`https://www.mercadolivre.com.br/p/${providerId}`),
  seller: "Loja",
  availability: "available",
  listingStatus: "active",
  currentPrice: { amountMinor: 9990, currency: "BRL" },
  observedAt: now,
  ratingAverage: 4.7,
  reviewCount: 120,
  ...overrides,
});

const setup = (
  rows: readonly ProductCandidate[],
  options: {
    target?: number;
    evidenceFor?: (id: string) => ProductEvidence | Error;
    voiceFails?: boolean;
    offers?: readonly Partial<Offer>[];
    history?: { productId: string; lastPublishedAt: Date }[];
    variantItemIds?: string[];
    claimTopUp?: boolean;
    search?: () => Promise<never[]>;
    failedKeys?: string[];
  } = {},
) => {
  const candidates = fakeCandidateRepository(rows);
  const policy: ResearchPolicy = {
    ...createResearchPolicy({
      id: "policy-1",
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 5,
      targetPendingLinks: options.target ?? 2,
    }),
  };
  const reads = { evidence: 0, voice: 0, claims: 0 };
  const queued = new Map<string, EnqueueJobInput>();
  const catalog: MarketplaceCatalog = {
    search: options.search ?? (async () => []),
    readProductEvidence: async (id) => {
      reads.evidence += 1;
      const result = options.evidenceFor?.(id) ?? evidence(id);
      if (result instanceof Error) throw result;
      return result;
    },
    readBuyerVoice: async (id): Promise<BuyerVoice> => {
      reads.voice += 1;
      if (options.voiceFails) throw new Error("voice_down");
      return {
        providerId: id,
        sourceUrl: new URL("https://www.mercadolivre.com.br/x"),
        observedAt: now,
        ratingAverage: 4.7,
        reviewCount: 120,
        positiveReviews: [{ rating: 5, title: "ok", text: "Ótima" }],
        negativeReviews: [],
        questions: [],
        pictures: [],
        unavailable: [],
      };
    },
  };
  const deps: AutonomyCycleDeps = {
    niches: {
      listForWorkspace: async () => [niche],
      findForWorkspace: async () => niche,
    },
    policies: {
      create: async (value) => value,
      findForNiche: async () => policy,
      listForWorkspace: async () => [policy],
      update: async (value) => value,
      listActiveDue: async () => [policy],
      claimForRun: async () => true,
      claimForTopUp: async () => {
        reads.claims += 1;
        return options.claimTopUp ?? true;
      },
      recordRunResult: async () => undefined,
    },
    candidates,
    offers: {
      listForWorkspace: async () => (options.offers ?? []) as Offer[],
      findForWorkspace: async ({ offerId: id }) =>
        ((options.offers ?? []).find((offer) => offer.id === id) as Offer | undefined) ?? null,
    },
    postingHistory: {
      productPostingHistory: async () =>
        (options.history ?? []).map((entry) => ({
          ...entry,
          offerTitle: "x",
          publishedCount: 1,
          channels: [],
        })),
    },
    content: {
      listVariantsForWorkspace: async () =>
        (options.variantItemIds ?? []).map((contentItemId) => ({ contentItemId }) as never),
    },
    jobs: {
      enqueue: async (job) => {
        queued.set(job.idempotencyKey, job);
        return { idempotencyKey: job.idempotencyKey } as never;
      },
    },
    jobStats: {
      listFailed: async () =>
        (options.failedKeys ?? []).map((idempotencyKey) => ({
          id: idempotencyKey,
          name: "x",
          idempotencyKey,
          terminalReason: "attempts_exhausted",
          updatedAt: now,
          attemptCount: 6,
        })),
    },
    marketplaceCatalogForWorkspace: () => catalog,
  };
  return { deps, candidates, reads, queued };
};

const states = (candidates: ReturnType<typeof fakeCandidateRepository>) =>
  Object.fromEntries([...candidates.rows.values()].map((row) => [row.id, row.state]));

describe("runAutonomyCycle", () => {
  it("expires awaiting candidates older than 14 days only", async () => {
    const { deps, candidates } = setup(
      [
        candidate("a", {
          state: "awaiting_affiliate_link",
          qualifiedAt: ago(15 * DAY),
        }),
        candidate("b", {
          state: "awaiting_affiliate_link",
          qualifiedAt: ago(13 * DAY),
        }),
      ],
      { target: 0 },
    );
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.expired).toBe(1);
    expect(states(candidates)).toEqual({
      a: "expired",
      b: "awaiting_affiliate_link",
    });
  });

  it("qualifies fresh discovered candidates up to the target and never beyond", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => candidate(id));
    const { deps, candidates } = setup(rows, { target: 2 });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.qualified).toBe(2);
    const awaiting = [...candidates.rows.values()].filter(
      (row) => row.state === "awaiting_affiliate_link",
    );
    expect(awaiting).toHaveLength(2);
    expect(awaiting[0]?.qualification?.buyerVoice?.untrusted).toBe(true);
    expect(result.discoveredRuns).toBe(0);
  });

  it("ignores discovered rows older than 7 days and runs discovery instead", async () => {
    const { deps, reads } = setup([candidate("a", { discoveredAt: ago(8 * DAY) })]);
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.discoveredRuns).toBe(1);
    expect(reads.claims).toBe(1);
    expect(result.qualified).toBe(0);
  });

  it("reads a product once when daily research stored it several times", async () => {
    const rows = [
      candidate("new", { providerId: "MLBsame", discoveredAt: ago(DAY / 2) }),
      candidate("old", { providerId: "MLBsame", discoveredAt: ago(2 * DAY) }),
    ];
    const { deps, candidates, reads } = setup(rows, {
      target: 5,
      evidenceFor: (id) => {
        const { ratingAverage: _rating, reviewCount: _reviews, ...unrated } = evidence(id);
        return unrated;
      },
    });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(reads.evidence).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(candidates.rows.get("old")?.state).toBe("duplicate");
    expect(candidates.rows.get("new")?.state).toBe("rejected");
  });

  it("queues one product per brand and at most two per category in a niche", async () => {
    const rows = ["e1", "e2", "c1", "c2", "c3"].map((id) => candidate(id));
    const facts: Record<string, Partial<ProductEvidence>> = {
      MLBe1: { brand: "Amazon", domainId: "MLB-SMART_SPEAKERS" },
      MLBe2: { brand: "amazon", domainId: "MLB-SMART_SPEAKERS" },
      MLBc1: { brand: "Omo", domainId: "MLB-CLEANERS" },
      MLBc2: { brand: "Cif", domainId: "MLB-CLEANERS" },
      MLBc3: { brand: "Veja", domainId: "MLB-CLEANERS" },
    };
    const { deps, candidates } = setup(rows, {
      target: 5,
      evidenceFor: (id) => evidence(id, facts[id] ?? {}),
    });
    await runAutonomyCycle(deps, { workspaceId, now });
    const awaiting = [...candidates.rows.values()]
      .filter((row) => row.state === "awaiting_affiliate_link")
      .map((row) => row.providerId);
    expect(awaiting).toEqual(["MLBe1", "MLBc1", "MLBc2"]);
    expect(candidates.rows.get("e2")?.state).toBe("rejected");
    expect(candidates.rows.get("c3")?.state).toBe("rejected");
  });

  it("does not discover when the policy ran in the last 6 hours", async () => {
    const { deps } = setup([], { claimTopUp: false });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.discoveredRuns).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("never queues duplicates: open, offered or cooling-down products", async () => {
    const { deps, candidates } = setup(
      [
        candidate("open", {
          providerId: "MLB1",
          state: "awaiting_affiliate_link",
          qualifiedAt: now,
        }),
        candidate("dupOpen", { providerId: "MLB1" }),
        candidate("dupOffer", { providerId: "MLB2" }),
        candidate("dupCooldown", { providerId: "MLB3" }),
      ],
      {
        target: 4,
        offers: [
          {
            id: offerId,
            state: "active",
            listingUrl: "https://www.mercadolivre.com.br/p/MLB2",
            snapshots: [],
          },
        ],
        history: [{ productId: "MLB3", lastPublishedAt: ago(2 * DAY) }],
      },
    );
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.duplicates).toBe(3);
    expect(result.providerReads).toBe(0);
    expect(states(candidates)).toMatchObject({
      dupOpen: "duplicate",
      dupOffer: "duplicate",
      dupCooldown: "duplicate",
    });
  });

  it("turns an open-product unique violation into a duplicate", async () => {
    const { deps, candidates } = setup([candidate("a")], { target: 1 });
    const original = candidates.transition;
    candidates.transition = async (input) => {
      if (input.to === "awaiting_affiliate_link")
        throw new Error("product_candidates_open_product_key");
      return original(input);
    };
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.duplicates).toBe(1);
    expect(result.qualified).toBe(0);
    expect(result.errors).toEqual([]);
    expect(states(candidates)).toEqual({ a: "duplicate" });
  });

  it("stops at 10 provider reads per niche and keeps the rest discovered", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => candidate(`r${index}`));
    const { deps, reads, candidates } = setup(rows, {
      target: 20,
      evidenceFor: () => new Error("noop"),
    });
    // evidence failing with INTERNAL_ERROR continues, so reads hit the budget.
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.providerReads).toBe(10);
    expect(reads.evidence).toBe(10);
    expect([...candidates.rows.values()].filter((row) => row.state === "discovered")).toHaveLength(
      12,
    );
  });

  it("counts evidence and buyer voice reads separately and qualifies without voice on failure", async () => {
    const { deps, candidates } = setup([candidate("a")], {
      target: 1,
      voiceFails: true,
    });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.providerReads).toBe(2);
    expect(result.qualified).toBe(1);
    expect(candidates.rows.get("a")?.qualification?.buyerVoice).toBeNull();
  });

  it("rejects products that fail the hard filters", async () => {
    const { deps, candidates } = setup([candidate("a")], {
      target: 1,
      evidenceFor: (id) => evidence(id, { reviewCount: 2 }),
    });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.rejected).toBe(1);
    expect(states(candidates)).toEqual({ a: "rejected" });
  });

  it("records provider failures as codes without throwing", async () => {
    const { deps } = setup([candidate("a")], {
      target: 1,
      evidenceFor: () => new Error("rate_limited"),
    });
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.errors).toEqual(["evidence:RATE_LIMITED"]);
    deps.candidates.listByState = async () => {
      throw new Error("db down");
    };
    const failed = await runAutonomyCycle(deps, { workspaceId, now });
    expect(failed.errors).toEqual(
      expect.arrayContaining(["release:INTERNAL_ERROR", "expire:INTERNAL_ERROR"]),
    );
  });

  it("releases a link claim without an offer after 15 minutes", async () => {
    const { deps, candidates } = setup(
      [
        candidate("old", { state: "linked", linkedAt: ago(16 * 60_000) }),
        candidate("fresh", { state: "linked", linkedAt: ago(5 * 60_000) }),
      ],
      { target: 0 },
    );
    await runAutonomyCycle(deps, { workspaceId, now });
    expect(states(candidates)).toEqual({
      old: "awaiting_affiliate_link",
      fresh: "linked",
    });
  });

  it("re-enqueues a package job only for linked candidates with an active offer", async () => {
    const { deps, queued } = setup(
      [
        candidate("a", { state: "linked", offerId, linkedAt: ago(DAY) }),
        candidate("b", {
          state: "linked",
          offerId: "22222222-2222-4222-8222-222222222222",
          linkedAt: ago(DAY),
        }),
      ],
      {
        target: 0,
        offers: [
          { id: offerId, state: "active", listingUrl: "", snapshots: [] },
          {
            id: "22222222-2222-4222-8222-222222222222",
            state: "archived",
            listingUrl: "",
            snapshots: [],
          },
        ],
      },
    );
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.packageJobsEnqueued).toBe(1);
    expect([...queued.keys()]).toEqual([`offer-package:${offerId}`]);
  });

  it("enqueues a package job for a draft offer too, not for an archived one", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const { deps, queued } = setup(
      [
        candidate("a", { state: "linked", offerId, linkedAt: ago(DAY) }),
        candidate("b", { state: "linked", offerId: other, linkedAt: ago(DAY) }),
      ],
      {
        target: 0,
        offers: [
          { id: offerId, state: "draft", listingUrl: "", snapshots: [] },
          { id: other, state: "archived", listingUrl: "", snapshots: [] },
        ],
      },
    );
    await runAutonomyCycle(deps, { workspaceId, now });
    expect([...queued.keys()]).toEqual([`offer-package:${offerId}`]);
  });

  it("rejects linked and in_production candidates whose job failed for good", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const qualification = { reasons: ["ok"] } as never;
    const { deps, candidates, queued } = setup(
      [
        candidate("a", { state: "linked", offerId, linkedAt: ago(DAY), qualification }),
        candidate("b", { state: "in_production", offerId: other, qualification }),
      ],
      {
        target: 0,
        offers: [{ id: offerId, state: "active", listingUrl: "", snapshots: [] }],
        failedKeys: [`offer-package:${offerId}`, `offer-copy:${uuidFromKey(`auto-sale:${other}`)}`],
      },
    );
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.rejected).toBe(2);
    expect(states(candidates)).toEqual({ a: "rejected", b: "rejected" });
    expect(candidates.rows.get("a")?.qualification?.reasons).toEqual([
      "ok",
      "package_failed:attempts_exhausted",
    ]);
    expect(queued.size).toBe(0);
  });

  it("consumes in_production candidates whose item has a reviewable variant", async () => {
    const { deps, candidates } = setup(
      [
        candidate("a", { state: "in_production", offerId }),
        candidate("b", {
          state: "in_production",
          offerId: "22222222-2222-4222-8222-222222222222",
        }),
      ],
      { target: 0, variantItemIds: [uuidFromKey(`auto-sale:${offerId}`)] },
    );
    const result = await runAutonomyCycle(deps, { workspaceId, now });
    expect(result.consumed).toBe(1);
    expect(states(candidates)).toEqual({ a: "consumed", b: "in_production" });
  });

  it("a second cycle has no further side effects", async () => {
    const rows = ["a", "b", "c"].map((id) => candidate(id));
    const { deps, candidates, queued } = setup(rows, { target: 2 });
    const first = await runAutonomyCycle(deps, { workspaceId, now });
    const snapshot = JSON.stringify([...candidates.rows.values()]);
    const second = await runAutonomyCycle(deps, { workspaceId, now });
    expect(first.qualified).toBe(2);
    expect(second).toEqual({
      expired: 0,
      qualified: 0,
      rejected: 0,
      duplicates: 0,
      discoveredRuns: 0,
      providerReads: 0,
      packageJobsEnqueued: 0,
      consumed: 0,
      errors: [],
    });
    expect(JSON.stringify([...candidates.rows.values()])).toBe(snapshot);
    expect(queued.size).toBe(0);
  });
});
