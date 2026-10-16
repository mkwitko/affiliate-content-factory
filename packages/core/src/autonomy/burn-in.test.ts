import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { uuidFromKey } from "../content/offer-package.js";
import type { EnqueueJobInput } from "../jobs/job.js";
import type { Niche } from "../niches/niche.js";
import type { MarketplaceCatalog, ProductEvidence } from "../offers/marketplace-catalog.js";
import type { Offer } from "../offers/offer.js";
import { createResearchPolicy, type ResearchPolicy } from "../research/research-policy.js";
import { runBurnIn, type BurnInDeps, type BurnInResult } from "./burn-in.js";
import { fakeCandidateRepository } from "./test-support.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const MIN = 60_000;
const TARGET = 3;
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

/** Everything that survives an API restart: the "database". */
const createStores = () => {
  return {
    candidates: fakeCandidateRepository(),
    offers: new Map<string, Offer>(),
    contentItems: new Set<string>(),
    readyItems: new Set<string>(),
    jobs: new Map<string, { name: string; status: string }>(),
    enqueueCalls: 0,
    lastTopUp: null as Date | null,
    searchSeq: 0,
    outage: false,
  };
};
type Stores = ReturnType<typeof createStores>;

/** A fresh deps object over the same stores, as after an API/worker restart. */
const makeDeps = (s: Stores): BurnInDeps => {
  const catalog: MarketplaceCatalog = {
    search: async () => {
      if (s.outage) throw new Error("catalog_down");
      return Array.from({ length: 5 }, () => {
        const providerId = `MLB${++s.searchSeq}`;
        return {
          providerId,
          title: "Panela inox",
          listingUrl: new URL(`https://www.mercadolivre.com.br/p/${providerId}`),
          seller: "Loja",
          availability: "available",
          listingStatus: "active" as const,
          currentPrice: { amountMinor: 9990, currency: "BRL" },
        };
      });
    },
    readProductEvidence: async (providerId): Promise<ProductEvidence> => {
      if (s.outage) throw new Error("catalog_down");
      return {
        providerId,
        title: "Panela inox",
        listingUrl: new URL(`https://www.mercadolivre.com.br/p/${providerId}`),
        seller: "Loja",
        availability: "available",
        listingStatus: "active",
        currentPrice: { amountMinor: 9990, currency: "BRL" },
        observedAt: new Date(),
        ratingAverage: 4.7,
        reviewCount: 120,
      };
    },
    readBuyerVoice: async () => {
      throw new Error("voice_down");
    },
  };
  const policy = createResearchPolicy({
    id: "policy-1",
    workspaceId,
    nicheId: "niche-1",
    frequency: "daily",
    maxCandidatesPerRun: 5,
    targetPendingLinks: TARGET,
  });
  const policies = {
    create: async (value: ResearchPolicy) => value,
    findForNiche: async () => policy,
    listForWorkspace: async () => [policy],
    update: async (value: ResearchPolicy) => value,
    listActiveDue: async () => [policy],
    claimForRun: async () => true,
    claimForTopUp: async (_id: string, now: Date, minIntervalMs: number) => {
      if (s.lastTopUp && now.getTime() - s.lastTopUp.getTime() < minIntervalMs) return false;
      s.lastTopUp = now;
      return true;
    },
    recordRunResult: async () => undefined,
  };
  const content = {
    listVariantsForWorkspace: async () =>
      [...s.readyItems].map((contentItemId) => ({
        contentItemId,
        state: "ready_for_review",
      })) as never,
    findContentItemForWorkspace: async () => null,
  };
  const jobStats = {
    countByStatus: async () => {
      const grouped = new Map<string, { name: string; status: string; count: number }>();
      for (const job of s.jobs.values()) {
        const key = `${job.name}/${job.status}`;
        grouped.set(key, { ...job, count: (grouped.get(key)?.count ?? 0) + 1 });
      }
      return [...grouped.values()];
    },
    listFailed: async () => [],
  };
  const candidates = s.candidates;
  const niches = { listForWorkspace: async () => [niche], findForWorkspace: async () => niche };
  return {
    cycle: {
      niches,
      policies,
      candidates,
      offers: {
        listForWorkspace: async () => [...s.offers.values()],
        findForWorkspace: async ({ offerId }) => s.offers.get(offerId) ?? null,
      },
      postingHistory: { productPostingHistory: async () => [] },
      content,
      jobs: {
        enqueue: async (job: EnqueueJobInput) => {
          s.enqueueCalls += 1;
          if (!s.jobs.has(job.idempotencyKey))
            s.jobs.set(job.idempotencyKey, { name: job.name, status: "PENDING" });
          return { idempotencyKey: job.idempotencyKey } as never;
        },
      },
      marketplaceCatalogForWorkspace: () => catalog,
    },
    status: {
      niches,
      candidates,
      policies,
      content,
      attempts: { listLatestForVariants: async () => new Map() },
      assets: { listForWorkspace: async () => [] },
      jobStats,
      affiliateLinkBuilderUrl: "https://builder.example/",
      generationPolicy: "local_only",
      autonomyEnabled: true,
    },
    counts: async () => ({
      offers: s.offers.size,
      contentItems: s.contentItems.size,
      publicationAttempts: 0,
    }),
  };
};

const fakeClock = () => {
  let t = Date.parse("2026-10-02T00:00:00Z");
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe("runBurnIn", () => {
  it("survives outage, absent home worker, a link and a restart over 300 cycles without side effects", async () => {
    const s = createStores();
    const clock = fakeClock();
    // Draft jobs left over from earlier work; the home worker is absent for cycles 50..100.
    for (const id of ["a", "b", "c"])
      s.jobs.set(`draft:${id}`, { name: "draft_offer_copy", status: "PENDING" });
    let linkedAt = -1;
    let afterRestart: string | null = null;

    const onCycle = (base: number) => (result: BurnInResult) => {
      const c = base + result.cycles; // cycles completed so far; the next cycle index
      s.outage = c >= 30 && c < 60;
      if (c === 40) {
        // Everything open expires or is rejected, so the next top-up must hit the dead catalog.
        for (const row of s.candidates.rows.values()) {
          if (row.state === "awaiting_affiliate_link")
            s.candidates.rows.set(row.id, { ...row, state: "expired" });
          if (row.state === "discovered")
            s.candidates.rows.set(row.id, { ...row, state: "rejected" });
        }
      }
      if (c >= 100 && c < 102)
        for (const job of s.jobs.values())
          if (job.name === "draft_offer_copy") job.status = "COMPLETED";
      if (c === 120 && linkedAt < 0) {
        // submit_affiliate_links: awaiting -> linked with an active offer.
        const row = [...s.candidates.rows.values()].find(
          (r) => r.state === "awaiting_affiliate_link",
        );
        if (!row) throw new Error("expected an awaiting candidate");
        const offerId = "11111111-1111-4111-8111-111111111111";
        s.offers.set(offerId, {
          id: offerId,
          workspaceId,
          state: "active",
          listingUrl: row.listingUrl,
          snapshots: [],
        } as unknown as Offer);
        s.candidates.rows.set(row.id, { ...row, state: "linked", offerId, linkedAt: clock.now() });
        linkedAt = c;
      }
      if (linkedAt >= 0 && c === linkedAt + 2) {
        // The package handler: content item, draft job, candidate -> in_production.
        const row = [...s.candidates.rows.values()].find((r) => r.state === "linked");
        const item = uuidFromKey(`auto-sale:${row?.offerId}`);
        s.contentItems.add(item);
        s.jobs.set("draft:new", { name: "draft_offer_copy", status: "COMPLETED" });
        if (row) s.candidates.rows.set(row.id, { ...row, state: "in_production" });
      }
      if (linkedAt >= 0 && c === linkedAt + 4) for (const i of s.contentItems) s.readyItems.add(i);
      if (c === 250)
        afterRestart = JSON.stringify([
          s.offers.size,
          s.contentItems.size,
          s.jobs.size,
          s.candidates.rows.size,
        ]);
    };

    const first = await runBurnIn(makeDeps(s), {
      workspaceIds: [workspaceId],
      hours: 33, // cycles 0..197
      intervalMs: 10 * MIN,
      clock,
      onCycle: onCycle(0),
    });
    // "API restart": fresh deps over the same stores; the second run continues.
    const second = await runBurnIn(makeDeps(s), {
      workspaceIds: [workspaceId],
      hours: 17,
      intervalMs: 10 * MIN,
      clock,
      onCycle: onCycle(first.cycles),
    });

    expect(first.cycles + second.cycles).toBe(300);
    expect(first.stoppedBy).toBe("elapsed");

    // No duplicates: one offer, one content item, one package job despite many enqueue requests.
    expect(s.offers.size).toBe(1);
    expect(s.contentItems.size).toBe(1);
    const packageJobs = [...s.jobs.values()].filter((j) => j.name === "produce_offer_package");
    expect(packageJobs).toHaveLength(1);
    expect(s.enqueueCalls).toBeGreaterThan(1);
    const openProducts = [...s.candidates.rows.values()]
      .filter((r) => ["awaiting_affiliate_link", "linked", "in_production"].includes(r.state))
      .map((r) => r.providerId);
    expect(new Set(openProducts).size).toBe(openProducts.length);

    // Bounded: awaiting never above target, queue never grew past the seeded drafts.
    for (const result of [first, second]) {
      expect(result.awaitingOverTargetMax).toBeLessThanOrEqual(0);
      expect(result.queueDepthMax).toBeLessThanOrEqual(3);
      expect(result.publicationAttemptsCreated).toBe(0);
      expect(result.violations).toEqual([]);
    }

    // The catalog outage is visible as a counted error code, and the run recovered afterwards.
    expect(first.totals.errorCodes["discover:INTERNAL_ERROR"]).toBeGreaterThanOrEqual(1);
    expect(first.totals.errors).toBeGreaterThan(0);
    const counts = await s.candidates.countByState({ workspaceId });
    expect(counts.awaiting_affiliate_link).toBe(TARGET);

    // The unfinished home-worker jobs showed up as pending work and were later completed.
    expect(first.jobs.some((j) => j.name === "draft_offer_copy" && j.status === "PENDING")).toBe(
      true,
    );

    // The link produced exactly one consumption; the restart repeated nothing.
    expect(first.totals.candidatesConsumed + second.totals.candidatesConsumed).toBe(1);
    expect(second.totals.candidatesConsumed).toBe(0);
    expect(second.totals.candidatesQualified).toBe(0);
    expect(
      JSON.stringify([s.offers.size, s.contentItems.size, s.jobs.size, s.candidates.rows.size]),
    ).toBe(afterRestart);
    expect(second.duplicatePrevention.idempotentEnqueueHits).toBeNull();
    expect(second.retries).toBeNull();
  });

  it("stops early on abort and reports why", async () => {
    const s = createStores();
    const controller = new AbortController();
    const result = await runBurnIn(makeDeps(s), {
      workspaceIds: [workspaceId],
      hours: 24,
      intervalMs: 10 * MIN,
      clock: fakeClock(),
      signal: controller.signal,
      onCycle: (r) => {
        if (r.cycles === 3) controller.abort();
      },
    });
    expect(result.cycles).toBe(3);
    expect(result.stoppedBy).toBe("signal");
    expect(result.endedAt).not.toBeNull();
  });
});
