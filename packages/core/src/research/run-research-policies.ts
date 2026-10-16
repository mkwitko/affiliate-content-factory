import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import type { NicheRepository } from "../niches/niche-repository.js";
import type {
  ProductCandidate as CatalogProduct,
  MarketplaceCatalog,
} from "../offers/marketplace-catalog.js";
import type { ProductCandidate } from "./product-candidate.js";
import type { ProductCandidateRepository } from "./product-candidate-repository.js";
import { isResearchPolicyDue, type ResearchPolicy } from "./research-policy.js";
import type { ResearchPolicyRepository } from "./research-policy-repository.js";

export type RunResearchPoliciesDeps = Readonly<{
  policies: ResearchPolicyRepository;
  niches: Pick<NicheRepository, "findForWorkspace">;
  candidates: ProductCandidateRepository;
  marketplaceCatalogForWorkspace: (workspaceId: WorkspaceId) => MarketplaceCatalog;
  now?: () => Date;
}>;

const dedupeByProviderId = (items: readonly CatalogProduct[]): readonly CatalogProduct[] => {
  const seen = new Map<string, CatalogProduct>();
  for (const item of items) if (!seen.has(item.providerId)) seen.set(item.providerId, item);
  return [...seen.values()];
};

const mapCatalogError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message === "mercado_livre_not_connected") return "CONNECTION_UNAVAILABLE";
  if (message === "rate_limited") return "RATE_LIMITED";
  return "INTERNAL_ERROR";
};

/** Tolerates malformed `niche.context` fields: anything that isn't an array of strings becomes empty. */
const toStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Product families no affiliate niche sells: a query like "organizador" also matches book editors. */
const EXCLUDED_DOMAINS: ReadonlySet<string> = new Set(["MLB-BOOKS"]);

/** Hard cap on Mercado Livre queries issued per policy run, regardless of pillar/prioritize count. */
const MAX_QUERIES_PER_RUN = 10;

/**
 * Searches, filters, ranks and stores one policy's candidates as `discovered`. Never claims the
 * policy: callers own claim and result recording. Catalog errors propagate.
 */
export const discoverCandidatesForPolicy = async (
  deps: Pick<RunResearchPoliciesDeps, "niches" | "candidates" | "marketplaceCatalogForWorkspace">,
  policy: ResearchPolicy,
  now: Date,
): Promise<Readonly<{ stored: readonly ProductCandidate[]; error: string | null }>> => {
  const niche = await deps.niches.findForWorkspace({
    workspaceId: policy.workspaceId,
    nicheId: policy.nicheId,
  });
  if (!niche) return { stored: [], error: "niche_not_found" };

  const context = (niche.context ?? {}) as Record<string, unknown>;
  const pillars = toStringArray(context.pillars);
  const prioritize = toStringArray(context.prioritize);
  const avoid = toStringArray(context.avoid);

  const queries = policy.explicitQueries.length
    ? policy.explicitQueries
    : [...pillars, ...prioritize];
  if (queries.length === 0) return { stored: [], error: "no_queries" };

  const catalog = deps.marketplaceCatalogForWorkspace(policy.workspaceId);
  const perQuery: (readonly CatalogProduct[])[] = [];
  for (const query of queries.slice(0, MAX_QUERIES_PER_RUN)) {
    // Sequential on purpose: bounds concurrent load on the provider and lets a
    // rate_limited response stop the run immediately instead of firing the rest anyway.
    // Best sellers first, so the deduplication keeps their rank. A refusal (the list is not
    // served to this app) falls back to search alone; a rate limit stops the run like search.
    if (catalog.searchBestSellers) {
      try {
        perQuery.push(
          await catalog.searchBestSellers({ query, limit: policy.maxCandidatesPerRun }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "rate_limited") throw error;
      }
    }
    perQuery.push(await catalog.search({ query, limit: policy.maxCandidatesPerRun }));
  }
  const results = dedupeByProviderId(perQuery.flat());

  const avoidTerms = avoid.map((term) => term.toLowerCase());
  const prioritizeTerms = prioritize.map((term) => term.toLowerCase());
  const filtered = results.filter((item) => {
    if (item.domainId && EXCLUDED_DOMAINS.has(item.domainId)) return false;
    const title = item.title.toLowerCase();
    if (avoidTerms.some((term) => title.includes(term))) return false;
    if (policy.priceMinMinor !== undefined && item.currentPrice.amountMinor < policy.priceMinMinor)
      return false;
    if (policy.priceMaxMinor !== undefined && item.currentPrice.amountMinor > policy.priceMaxMinor)
      return false;
    return true;
  });

  // ponytail: naive heuristic — count of matched `prioritize` terms in the title (desc),
  // then best-seller rank, then units sold (desc, Mercado Livre's referential count), then price ascending. Upgrade to CTR/attribution-based ranking once that data
  // exists (see money-maker-operator SKILL.md's note on the missing learnings layer).
  const prioritizeScore = (item: CatalogProduct) =>
    prioritizeTerms.filter((term) => item.title.toLowerCase().includes(term)).length;
  const ranked = [...filtered]
    .sort((a, b) => {
      const scoreDelta = prioritizeScore(b) - prioritizeScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      const rankA = a.bestSellerRank ?? Number.POSITIVE_INFINITY;
      const rankB = b.bestSellerRank ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA < rankB ? -1 : 1;
      const soldDelta = (b.soldQuantity ?? 0) - (a.soldQuantity ?? 0);
      return soldDelta !== 0 ? soldDelta : a.currentPrice.amountMinor - b.currentPrice.amountMinor;
    })
    .slice(0, policy.maxCandidatesPerRun);

  const stored: readonly ProductCandidate[] = ranked.map((item, index) =>
    Object.freeze({
      id: randomUUID(),
      workspaceId: policy.workspaceId,
      nicheId: policy.nicheId,
      policyId: policy.id,
      providerId: item.providerId,
      title: item.title,
      listingUrl: item.listingUrl.toString(),
      seller: item.seller,
      availability: item.availability,
      priceMinor: item.currentPrice.amountMinor,
      currency: item.currentPrice.currency,
      rank: index,
      ...(item.bestSellerRank !== undefined ? { bestSellerRank: item.bestSellerRank } : {}),
      discoveredAt: now,
      state: "discovered" as const,
    }),
  );
  if (stored.length > 0) await deps.candidates.createMany(stored);
  return { stored, error: null };
};

/**
 * Sweeps every active-and-due research policy: searches Mercado Livre for the workspace's
 * connection, drops items matching an avoid term or outside the price range, ranks the rest,
 * and stores the top `maxCandidatesPerRun`. Never creates offers, never publishes, never spends
 * money. A failure on one policy sets `lastError` and moves on — it never aborts the sweep.
 */
export const runDueResearchPolicies = async (deps: RunResearchPoliciesDeps): Promise<void> => {
  const now = (deps.now ?? (() => new Date()))();
  const candidatePolicies = await deps.policies.listActiveDue(now);
  const duePolicies = candidatePolicies.filter((policy) => isResearchPolicyDue(policy, now));

  for (const policy of duePolicies) {
    // Claim-then-record: only a policy that is still ACTIVE and due gets claimed, so a
    // pause/revoke mid-run is never overwritten and a concurrent replica never double-runs it.
    const claimed = await deps.policies.claimForRun(policy.id, now);
    if (!claimed) continue;

    const recordResult = async (lastError: string | null) => {
      try {
        await deps.policies.recordRunResult(policy.id, lastError);
      } catch {
        // Guarded: the claim already recorded lastRunAt; a failure here must not abort the sweep.
      }
    };

    try {
      const { error } = await discoverCandidatesForPolicy(deps, policy, now);
      await recordResult(error);
    } catch (error) {
      // Any unexpected failure (a bad search response, a DB error while storing candidates,
      // ...) is contained here so one policy can never abort the sweep for the rest.
      await recordResult(mapCatalogError(error));
    }
  }
};
