import { beforeEach, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { EnqueueJobInput, JobQueue } from "@money-maker/core/jobs/job";
import type { ProductEvidence } from "@money-maker/core/offers/marketplace-catalog";
import type { Offer } from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { AffiliateLinkResolver } from "@money-maker/providers/mercado-livre/affiliate-link";
import type { McpDependencies } from "../server.js";
import { fakeCandidateRepository } from "./candidate-repository-fake.js";
import { submitAffiliateLinksTool } from "./submit-affiliate-links.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date();

const candidate = (n: number, overrides: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id: `cand-${n}`,
  workspaceId,
  nicheId: "niche-1",
  policyId: "policy-1",
  providerId: `MLB${n}`,
  title: `Produto ${n}`,
  listingUrl: `https://www.mercadolivre.com.br/p/MLB${n}`,
  seller: "Loja",
  availability: "available",
  priceMinor: 9990,
  currency: "BRL",
  rank: 0,
  discoveredAt: now,
  state: "awaiting_affiliate_link",
  ...overrides,
});

const evidenceFor = (productId: string): ProductEvidence => ({
  providerId: productId,
  title: `Produto ${productId}`,
  listingUrl: new URL(`https://www.mercadolivre.com.br/p/${productId}`),
  seller: "Loja",
  availability: "available",
  listingStatus: "active",
  currentPrice: { amountMinor: 9990, currency: "BRL" },
  observedAt: now,
});

const setup = (
  role: "owner" | "operator" | "reviewer" = "operator",
  rows: readonly ProductCandidate[] = [candidate(1), candidate(2), candidate(3)],
) => {
  const candidates = fakeCandidateRepository(rows);
  const offers: Offer[] = [];
  const jobs: EnqueueJobInput[] = [];
  const reads: string[] = [];
  const state = { failEvidenceFor: new Set<string>(), failEnqueue: false };
  const offerRepository = {
    create: async (offer: Offer) => {
      offers.push(offer);
      return offer;
    },
    listForWorkspace: async () => [...offers],
    findForWorkspace: async ({ offerId }: { offerId: string }) =>
      offers.find((offer) => offer.id === offerId) ?? null,
    addSnapshot: async ({
      offerId,
      snapshot,
    }: {
      offerId: string;
      snapshot: Offer["snapshots"][number];
    }) => {
      const index = offers.findIndex((offer) => offer.id === offerId);
      const current = offers[index];
      if (!current) return null;
      const next = { ...current, snapshots: [...current.snapshots, snapshot] };
      offers[index] = next;
      return next;
    },
    activate: async ({ offerId, snapshotId }: { offerId: string; snapshotId: string }) => {
      const index = offers.findIndex((offer) => offer.id === offerId);
      const current = offers[index];
      if (!current) return null;
      const next = { ...current, state: "active" as const, activeSnapshotId: snapshotId };
      offers[index] = next;
      return next;
    },
  } as unknown as OfferRepository;
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    addMembership: async () => undefined,
  };
  const resolver: AffiliateLinkResolver = async (url) => {
    if (url.pathname === "/net") return { productId: null, finalUrl: null, failure: "network" };
    const match = /\/(MLB\d+)$/.exec(url.pathname);
    if (url.pathname === "/loop" || !match) return { productId: null, finalUrl: url };
    return { productId: match[1] as string, finalUrl: url };
  };
  const deps: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces,
    productCandidateRepository: candidates,
    offerRepository,
    audit: { record: async () => "audit" },
    affiliateLinkResolver: resolver,
    marketplaceCatalogForWorkspace: () => ({
      search: async () => [],
      readBuyerVoice: async () => {
        throw new Error("not_used");
      },
      readProductEvidence: async (productId: string) => {
        reads.push(productId);
        if (state.failEvidenceFor.has(productId)) throw new Error("boom");
        return evidenceFor(productId);
      },
    }),
    jobQueue: {
      enqueue: async (job: EnqueueJobInput) => {
        if (state.failEnqueue) throw new Error("queue_down");
        jobs.push(job);
        return { id: `job-${jobs.length}` } as never;
      },
    } as unknown as JobQueue,
  };
  return { deps, candidates, offers, jobs, reads, state };
};

const link = (n: number, host = "https://meli.la") => ({
  candidateId: `cand-${n}`,
  affiliateUrl: `${host}/x/MLB${n}`,
});
const run = (deps: McpDependencies, links: unknown[]) =>
  submitAffiliateLinksTool({ workspaceId, links }, actorId, deps);
const results = (result: Awaited<ReturnType<typeof run>>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return (result.value as { results: Record<string, unknown>[] }).results;
};

describe("submit_affiliate_links", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("links a batch of three: one offer, one package job and one linked candidate each", async () => {
    const out = results(await run(ctx.deps, [link(1), link(2), link(3)]));
    expect(out.map((item) => item.status)).toEqual(["linked", "linked", "linked"]);
    expect(out.every((item) => item.offerState === "active")).toBe(true);
    expect(ctx.offers).toHaveLength(3);
    expect(ctx.jobs.map((job) => job.name)).toEqual(Array(3).fill("produce_offer_package"));
    expect(ctx.jobs.map((job) => job.idempotencyKey)).toEqual(
      ctx.offers.map((offer) => `offer-package:${offer.id}`),
    );
    for (const row of ctx.candidates.rows.values()) {
      expect(row.state).toBe("linked");
      expect(row.offerId).toBeDefined();
    }
  });

  it("is idempotent: a repeated submission is already_linked with no new offer or job", async () => {
    await run(ctx.deps, [link(1)]);
    const again = results(await run(ctx.deps, [link(1)]));
    expect(again[0]).toMatchObject({ status: "already_linked", offerId: ctx.offers[0]?.id });
    expect(ctx.offers).toHaveLength(1);
    expect(ctx.jobs).toHaveLength(1);
  });

  it("reports wrong_product and leaves the candidate awaiting", async () => {
    const out = results(
      await run(ctx.deps, [{ candidateId: "cand-1", affiliateUrl: "https://meli.la/x/MLB999" }]),
    );
    expect(out[0]).toMatchObject({ status: "wrong_product" });
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("awaiting_affiliate_link");
    expect(ctx.offers).toHaveLength(0);
  });

  it("reports unsupported_redirect when the link does not lead to a catalog product", async () => {
    const out = results(
      await run(ctx.deps, [{ candidateId: "cand-1", affiliateUrl: "https://meli.la/loop" }]),
    );
    expect(out[0]).toMatchObject({ status: "invalid", reason: "unsupported_redirect" });
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("awaiting_affiliate_link");
  });

  it("rejects hosts outside the Mercado Livre allowlist and non-https links without resolving them", async () => {
    let resolved = 0;
    ctx.deps = {
      ...ctx.deps,
      affiliateLinkResolver: async (url) => {
        resolved += 1;
        return { productId: "MLB1", finalUrl: url };
      },
    };
    const out = results(
      await run(ctx.deps, [
        { candidateId: "cand-1", affiliateUrl: "https://evil.example.com/MLB1" },
        { candidateId: "cand-2", affiliateUrl: "http://meli.la/MLB2" },
      ]),
    );
    expect(out.map((item) => item.reason)).toEqual(["host_not_allowed", "host_not_allowed"]);
    expect(resolved).toBe(0);
  });

  it("one bad link does not stop the others", async () => {
    const out = results(
      await run(ctx.deps, [
        { candidateId: "cand-1", affiliateUrl: "https://meli.la/x/MLB5" },
        link(2),
        { candidateId: "missing", affiliateUrl: "https://meli.la/x/MLB3" },
      ]),
    );
    expect(out.map((item) => item.status)).toEqual(["wrong_product", "linked", "invalid"]);
  });

  it("a network failure while checking the link is retryable and does not claim the candidate", async () => {
    const out = results(
      await run(ctx.deps, [{ candidateId: "cand-1", affiliateUrl: "https://meli.la/net" }]),
    );
    expect(out[0]).toMatchObject({ status: "import_failed", retryable: true });
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("awaiting_affiliate_link");
  });

  it("releases the claim when the import fails", async () => {
    ctx.state.failEvidenceFor.add("MLB1");
    const out = results(await run(ctx.deps, [link(1)]));
    expect(out[0]).toMatchObject({ status: "import_failed", retryable: true });
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("awaiting_affiliate_link");
    expect(ctx.jobs).toHaveLength(0);
    ctx.state.failEvidenceFor.clear();
    expect(results(await run(ctx.deps, [link(1)]))[0]?.status).toBe("linked");
  });

  it("does not enqueue when the claim is lost before the offer is attached", async () => {
    const repo = ctx.deps.productCandidateRepository!;
    const transition = repo.transition.bind(repo);
    let calls = 0;
    repo.transition = async (input) => (++calls === 2 ? null : transition(input));
    const out = results(await run(ctx.deps, [link(1)]));
    expect(out[0]).toMatchObject({ status: "import_failed", reason: "claim_lost" });
    expect(ctx.jobs).toHaveLength(0);
  });

  it("releases the claim when enqueueing fails, and the retry reuses the created offer", async () => {
    ctx.state.failEnqueue = true;
    expect(results(await run(ctx.deps, [link(1)]))[0]?.status).toBe("import_failed");
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("awaiting_affiliate_link");
    ctx.state.failEnqueue = false;
    expect(results(await run(ctx.deps, [link(1)]))[0]?.status).toBe("linked");
    expect(ctx.offers).toHaveLength(1);
    expect(ctx.jobs).toHaveLength(1);
  });

  it("reuses an existing offer for the same product instead of importing another", async () => {
    await run(ctx.deps, [link(1)]);
    const first = ctx.offers[0] as Offer;
    ctx.candidates.rows.set(
      "cand-1b",
      candidate(1, { id: "cand-1b", discoveredAt: new Date(now.getTime() + 1) }),
    );
    ctx.candidates.rows.set("cand-1", { ...candidate(1), state: "consumed" });
    ctx.reads.length = 0;
    const out = results(
      await run(ctx.deps, [{ candidateId: "cand-1b", affiliateUrl: "https://meli.la/x/MLB1" }]),
    );
    expect(out[0]).toMatchObject({ status: "linked", offerId: first.id });
    expect(ctx.offers).toHaveLength(1);
    expect(ctx.reads).toEqual([]);
  });

  it("keeps the candidate linked with a draft offer when activation fails", async () => {
    const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const original = ctx.deps.marketplaceCatalogForWorkspace;
    ctx.deps = {
      ...ctx.deps,
      marketplaceCatalogForWorkspace: (ws) => ({
        ...(original?.(ws) as NonNullable<ReturnType<NonNullable<typeof original>>>),
        readProductEvidence: async (id: string) => ({ ...evidenceFor(id), observedAt: stale }),
      }),
    };
    const out = results(await run(ctx.deps, [link(1)]));
    expect(out[0]).toMatchObject({ status: "linked", offerState: "draft" });
    expect(out[0]?.activationError).toBeTypeOf("string");
    expect(out[0]).not.toHaveProperty("jobId");
    expect(ctx.candidates.rows.get("cand-1")?.state).toBe("linked");
    expect(ctx.jobs).toHaveLength(0);
  });

  it("reports expired_candidate for candidates that left the queue", async () => {
    ctx = setup("operator", [
      candidate(1, { state: "expired" }),
      candidate(2, { state: "discovered" }),
    ]);
    const out = results(await run(ctx.deps, [link(1), link(2)]));
    expect(out.map((item) => item.status)).toEqual(["expired_candidate", "expired_candidate"]);
  });

  it("denies reviewers, enforces workspace scope, and validates input", async () => {
    const denied = setup("reviewer");
    expect((await run(denied.deps, [link(1)])).ok).toBe(false);
    expect(denied.offers).toHaveLength(0);
    const foreign = setup("operator", [
      candidate(1, { workspaceId: parseWorkspaceId("c3b0e04a-0eb7-43d8-89c5-b7db207a7237") }),
    ]);
    expect(results(await run(foreign.deps, [link(1)]))[0]).toMatchObject({ status: "invalid" });
    expect(await run(ctx.deps, [])).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(await run(ctx.deps, [link(1), link(1)])).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
});
