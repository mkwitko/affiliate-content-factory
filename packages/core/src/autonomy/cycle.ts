import type { WorkspaceId } from "@money-maker/contracts";
import type { ContentRepository } from "../content/content-repository.js";
import { uuidFromKey } from "../content/offer-package.js";
import {
  createDraftOfferCopyJob,
  createProduceOfferPackageJob,
  type JobQueue,
} from "../jobs/job.js";
import type { JobStats } from "../jobs/job-stats.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import type { BuyerVoice, ProductEvidence } from "../offers/marketplace-catalog.js";
import { productIdFromOffer } from "../offers/offer.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import {
  isProductInCooldown,
  type ProductPostingHistoryRepository,
} from "../offers/product-posting-history.js";
import { duplicateReason, qualifyCandidate } from "../research/candidate-qualification.js";
import type { ProductCandidate } from "../research/product-candidate.js";
import type { ProductCandidateRepository } from "../research/product-candidate-repository.js";
import type { ResearchPolicyRepository } from "../research/research-policy-repository.js";
import {
  discoverCandidatesForPolicy,
  type RunResearchPoliciesDeps,
} from "../research/run-research-policies.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const AWAITING_EXPIRY_MS = 14 * DAY_MS;
export const DISCOVERED_FRESH_MS = 7 * DAY_MS;
export const DISCOVERY_MIN_INTERVAL_MS = 6 * HOUR_MS;
export const LINK_CLAIM_STALE_MS = 15 * 60 * 1000;
export const PROVIDER_READS_PER_NICHE = 10;
/** Owner 2026-10-15: a varied queue, so one product per brand and two per category per niche. */
export const MAX_QUEUED_PER_CATEGORY = 2;
const SCAN = 200;

export type AutonomyCycleDeps = Readonly<{
  niches: Pick<NicheRepository, "listForWorkspace" | "findForWorkspace">;
  policies: ResearchPolicyRepository;
  candidates: ProductCandidateRepository;
  offers: Pick<OfferRepository, "listForWorkspace" | "findForWorkspace">;
  postingHistory: ProductPostingHistoryRepository;
  content: Pick<ContentRepository, "listVariantsForWorkspace">;
  jobs: Pick<JobQueue, "enqueue">;
  /** Lets the cycle release candidates whose package or copy job failed for good. */
  jobStats?: Pick<JobStats, "listFailed">;
  marketplaceCatalogForWorkspace: RunResearchPoliciesDeps["marketplaceCatalogForWorkspace"];
}>;

export type AutonomyCounters = {
  expired: number;
  qualified: number;
  rejected: number;
  duplicates: number;
  discoveredRuns: number;
  providerReads: number;
  /** Idempotent enqueue requests for linked candidates; an existing job is not duplicated. */
  packageJobsEnqueued: number;
  consumed: number;
  errors: string[];
};

const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  if (message === "rate_limited") return "RATE_LIMITED";
  if (message === "mercado_livre_not_connected") return "CONNECTION_UNAVAILABLE";
  return "INTERNAL_ERROR";
};

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002" ||
  (error instanceof Error && error.message.includes("product_candidates_open_product_key"));

const toStrings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Workspaces with an active research policy: the set the worker loop runs the cycle for. */
export const listAutonomyWorkspaces = async (
  policies: Pick<ResearchPolicyRepository, "listActiveDue">,
  now: Date,
): Promise<readonly WorkspaceId[]> => [
  ...new Set(
    (await policies.listActiveDue(now))
      .filter((policy) => policy.status === "active")
      .map((policy) => policy.workspaceId),
  ),
];

/**
 * One bounded, idempotent pass: expire stale awaiting candidates, top up each affiliate niche to
 * its target, repair stuck link claims, re-enqueue package jobs and mark finished candidates
 * consumed. Never approves, publishes or spends; failures become error codes, never throws.
 */
export const runAutonomyCycle = async (
  deps: AutonomyCycleDeps,
  input: Readonly<{ workspaceId: WorkspaceId; now: Date }>,
): Promise<AutonomyCounters> => {
  const { workspaceId, now } = input;
  const out: AutonomyCounters = {
    expired: 0,
    qualified: 0,
    rejected: 0,
    duplicates: 0,
    discoveredRuns: 0,
    providerReads: 0,
    packageJobsEnqueued: 0,
    consumed: 0,
    errors: [],
  };
  const guard = async (step: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      out.errors.push(`${step}:${errorCode(error)}`);
    }
  };
  const transition = (
    candidate: ProductCandidate,
    to: ProductCandidate["state"],
    extra: {
      offerId?: string | null;
      qualification?: ProductCandidate["qualification"];
    } = {},
  ) =>
    deps.candidates.transition({
      workspaceId,
      id: candidate.id,
      from: [candidate.state],
      to,
      at: now,
      ...(extra.offerId !== undefined ? { offerId: extra.offerId } : {}),
      ...(extra.qualification ? { qualification: extra.qualification } : {}),
    });

  // Repair a claim whose import never finished, then expire stale awaiting rows.
  await guard("release", async () => {
    for (const row of await deps.candidates.listByState({
      workspaceId,
      states: ["linked"],
      take: SCAN,
    }))
      if (
        !row.offerId &&
        row.linkedAt &&
        now.getTime() - row.linkedAt.getTime() > LINK_CLAIM_STALE_MS
      )
        await transition(row, "awaiting_affiliate_link", { offerId: null });
  });
  await guard("expire", async () => {
    for (const row of await deps.candidates.listByState({
      workspaceId,
      states: ["awaiting_affiliate_link"],
      take: SCAN,
    }))
      if (
        now.getTime() - (row.qualifiedAt ?? row.discoveredAt).getTime() > AWAITING_EXPIRY_MS &&
        (await transition(row, "expired"))
      )
        out.expired += 1;
  });

  await guard("topup", async () => {
    const niches = ((await deps.niches.listForWorkspace?.(workspaceId)) ?? []).filter(
      (niche) => niche.state === "active" && niche.kind === "affiliate",
    );
    const policies = (await deps.policies.listForWorkspace(workspaceId)).filter(
      (policy) => policy.status === "active" && policy.targetPendingLinks > 0,
    );
    if (niches.length === 0 || policies.length === 0) return;
    const open = await deps.candidates.listByState({
      workspaceId,
      states: ["awaiting_affiliate_link", "linked", "in_production"],
      take: SCAN,
    });
    const openProductIds = new Set(open.map((row) => row.providerId));
    const offerProductIds = new Set<string>();
    for (const offer of (await deps.offers.listForWorkspace?.(workspaceId)) ?? []) {
      const productId = productIdFromOffer(offer);
      if (productId && (offer.state === "draft" || offer.state === "active"))
        offerProductIds.add(productId);
    }
    const catalog = deps.marketplaceCatalogForWorkspace(workspaceId);

    for (const niche of niches) {
      const policy = policies.find((candidate) => candidate.nicheId === niche.id);
      if (!policy) continue;
      await guard(`niche:${niche.id}`, async () => {
        const awaiting = (await deps.candidates.countByState({ workspaceId, nicheId: niche.id }))
          .awaiting_affiliate_link;
        const need = policy.targetPendingLinks - awaiting;
        if (need <= 0) return;

        // Daily research stores the same product again each day: read only its newest row.
        const fresh = new Map<string, ProductCandidate>();
        for (const row of (
          await deps.candidates.listByState({
            workspaceId,
            nicheId: niche.id,
            states: ["discovered"],
            take: SCAN,
          })
        )
          .filter((row) => now.getTime() - row.discoveredAt.getTime() <= DISCOVERED_FRESH_MS)
          .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())) {
          if (!fresh.has(row.providerId)) fresh.set(row.providerId, row);
          else if (await transition(row, "duplicate")) out.duplicates += 1;
        }
        let pool = [...fresh.values()].slice(0, need * 2);
        if (
          pool.length === 0 &&
          (await deps.policies.claimForTopUp(policy.id, now, DISCOVERY_MIN_INTERVAL_MS))
        ) {
          out.discoveredRuns += 1;
          let error: string | null = null;
          try {
            const found = await discoverCandidatesForPolicy(
              {
                niches: deps.niches,
                candidates: deps.candidates,
                marketplaceCatalogForWorkspace: deps.marketplaceCatalogForWorkspace,
              },
              policy,
              now,
            );
            pool = found.stored.slice(0, need * 2);
            error = found.error;
          } catch (caught) {
            error = errorCode(caught);
          }
          await deps.policies.recordRunResult(policy.id, error).catch(() => undefined);
          if (error) out.errors.push(`discover:${error}`);
        }

        const cooldownProductIds = new Set(
          (
            await deps.postingHistory.productPostingHistory({
              workspaceId,
              nicheId: niche.id,
            })
          )
            .filter((entry) => isProductInCooldown(entry.lastPublishedAt, now))
            .map((entry) => entry.productId),
        );
        const prioritize = toStrings(((niche.context ?? {}) as Record<string, unknown>).prioritize);
        const brands = new Set<string>();
        const categories = new Map<string, number>();
        const remember = (facts: ProductCandidate["qualification"] | undefined) => {
          const brand = facts?.facts.brand?.trim().toLowerCase();
          const category = facts?.facts.domainId;
          if (brand) brands.add(brand);
          if (category) categories.set(category, (categories.get(category) ?? 0) + 1);
        };
        for (const row of open)
          if (row.nicheId === niche.id && row.state === "awaiting_affiliate_link")
            remember(row.qualification);
        let reads = 0;
        let queued = 0;
        for (const row of pool) {
          if (queued >= need || reads >= PROVIDER_READS_PER_NICHE) break;
          const markDuplicate = async () => {
            if (await transition(row, "duplicate")) out.duplicates += 1;
          };
          if (
            duplicateReason(row.providerId, {
              openProductIds,
              offerProductIds,
              cooldownProductIds,
            })
          ) {
            await markDuplicate();
            continue;
          }
          let evidence: ProductEvidence;
          reads += 1;
          out.providerReads += 1;
          try {
            evidence = await catalog.readProductEvidence(row.providerId);
          } catch (error) {
            out.errors.push(`evidence:${errorCode(error)}`);
            if (errorCode(error) !== "INTERNAL_ERROR") break;
            continue;
          }
          let voice: BuyerVoice | null = null;
          if (reads < PROVIDER_READS_PER_NICHE) {
            reads += 1;
            out.providerReads += 1;
            voice = await catalog.readBuyerVoice(row.providerId).catch(() => null);
          }
          const outcome = qualifyCandidate({
            evidence,
            voice,
            prioritize,
            bestSellerRank: row.bestSellerRank,
            now,
          });
          if (outcome.kind === "duplicate") {
            await markDuplicate();
          } else if (outcome.kind === "rejected") {
            if (await transition(row, "rejected")) out.rejected += 1;
          } else if (
            brands.has(outcome.qualification.facts.brand?.trim().toLowerCase() ?? "") ||
            (categories.get(outcome.qualification.facts.domainId ?? "") ?? 0) >=
              MAX_QUEUED_PER_CATEGORY
          ) {
            if (await transition(row, "rejected", { qualification: outcome.qualification }))
              out.rejected += 1;
          } else {
            try {
              const moved = await transition(row, "awaiting_affiliate_link", {
                qualification: outcome.qualification,
              });
              if (moved) {
                out.qualified += 1;
                queued += 1;
                openProductIds.add(row.providerId);
                remember(outcome.qualification);
              }
            } catch (error) {
              if (!isUniqueViolation(error)) throw error;
              await markDuplicate();
            }
          }
        }
      });
    }
  });

  // ponytail: reads the 100 newest failed jobs; older ones stay in needs_attention until paged.
  let failedKeys: Map<string, string> | undefined;
  const failedReason = async (key: string): Promise<string | undefined> => {
    failedKeys ??= new Map(
      (await (deps.jobStats?.listFailed({ workspaceId, since: new Date(0), take: 100 }) ?? [])).map(
        (job) => [job.idempotencyKey, job.terminalReason ?? "failed"],
      ),
    );
    return failedKeys.get(key);
  };
  // A job that failed for good frees the slot: the candidate is rejected with the reason.
  const rejectFailed = async (row: ProductCandidate, key: string): Promise<boolean> => {
    const reason = await failedReason(key);
    if (!reason || !row.qualification) return false;
    return Boolean(
      await transition(row, "rejected", {
        qualification: {
          ...row.qualification,
          reasons: [...row.qualification.reasons, `package_failed:${reason}`],
        },
      }),
    );
  };

  await guard("package", async () => {
    for (const row of await deps.candidates.listByState({
      workspaceId,
      states: ["linked"],
      take: SCAN,
    })) {
      if (!row.offerId) continue;
      if (
        await rejectFailed(
          row,
          createProduceOfferPackageJob({ workspaceId, offerId: row.offerId }).idempotencyKey,
        )
      ) {
        out.rejected += 1;
        continue;
      }
      const offer = await deps.offers.findForWorkspace({
        workspaceId,
        offerId: row.offerId,
      });
      // produce_offer_package refreshes and activates drafts itself.
      if (offer?.state !== "active" && offer?.state !== "draft") continue;
      await deps.jobs.enqueue(createProduceOfferPackageJob({ workspaceId, offerId: offer.id }));
      out.packageJobsEnqueued += 1;
    }
  });

  await guard("consume", async () => {
    const producing = await deps.candidates.listByState({
      workspaceId,
      states: ["in_production"],
      take: SCAN,
    });
    if (producing.length === 0) return;
    const ready = new Set(
      (
        await deps.content.listVariantsForWorkspace(workspaceId, {
          states: ["ready_for_review", "approved", "scheduled", "published"],
          limit: 500,
        })
      ).map((variant) => variant.contentItemId),
    );
    for (const row of producing) {
      if (!row.offerId) continue;
      const itemId = uuidFromKey(`auto-sale:${row.offerId}`);
      if (ready.has(itemId)) {
        if (await transition(row, "consumed")) out.consumed += 1;
      } else if (
        await rejectFailed(
          row,
          createDraftOfferCopyJob({ workspaceId, contentItemId: itemId }).idempotencyKey,
        )
      )
        out.rejected += 1;
    }
  });

  return out;
};
