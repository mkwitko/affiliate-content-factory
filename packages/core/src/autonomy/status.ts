import type { WorkspaceId } from "@money-maker/contracts";
import type { ContentRepository } from "../content/content-repository.js";
import type { VariantState } from "../content/content.js";
import type { HomeWorkerTokenRepository } from "../home-worker/tokens.js";
import { LOCAL_AI_JOB_NAMES } from "../jobs/job.js";
import type { JobStats } from "../jobs/job-stats.js";
import type { ProductCandidateRepository } from "../research/product-candidate-repository.js";
import type { ResearchPolicyRepository } from "../research/research-policy-repository.js";
import {
  HUMAN_ACTION_KINDS,
  NEEDS_ATTENTION_WINDOW_MS,
  listHumanActions,
  type HumanActionDeps,
  type HumanActionKind,
} from "./human-actions.js";

/** A home worker polls about every 2.5 minutes; two missed polls mean it is offline. */
export const HOME_WORKER_ONLINE_MS = 5 * 60 * 1000;

export type AutonomyStatusDeps = HumanActionDeps &
  Readonly<{
    candidates: Pick<ProductCandidateRepository, "listByState" | "countByState">;
    policies: Pick<ResearchPolicyRepository, "listForWorkspace">;
    content: Pick<ContentRepository, "listVariantsForWorkspace" | "findContentItemForWorkspace">;
    jobStats?: JobStats;
    homeTokens?: Pick<HomeWorkerTokenRepository, "listForWorkspace">;
    generationPolicy: string;
    autonomyEnabled: boolean;
  }>;

export const getAutonomyStatus = async (
  deps: AutonomyStatusDeps,
  input: Readonly<{ workspaceId: WorkspaceId; now: Date }>,
) => {
  const { workspaceId, now } = input;
  const niches = (await deps.niches.listForWorkspace?.(workspaceId)) ?? [];
  const policies = await deps.policies.listForWorkspace(workspaceId);
  const affiliate = [];
  for (const niche of niches.filter((entry) => entry.kind === "affiliate")) {
    const counts = await deps.candidates.countByState({
      workspaceId,
      nicheId: niche.id,
    });
    affiliate.push({
      nicheId: niche.id,
      nicheName: niche.name,
      awaiting: counts.awaiting_affiliate_link,
      linked: counts.linked,
      inProduction: counts.in_production,
      consumed: counts.consumed,
      target: policies.find((policy) => policy.nicheId === niche.id)?.targetPendingLinks ?? 0,
    });
  }

  // ponytail: counts the newest 500 variants; add a grouped repository query if that is exceeded.
  const variantsByState: Partial<Record<VariantState, number>> = {};
  for (const variant of await deps.content.listVariantsForWorkspace(workspaceId, { limit: 500 }))
    variantsByState[variant.state] = (variantsByState[variant.state] ?? 0) + 1;

  const jobs = (await deps.jobStats?.countByStatus({ workspaceId })) ?? [];
  const localNames: readonly string[] = LOCAL_AI_JOB_NAMES;
  const queueDepth = jobs
    .filter(
      (job) =>
        localNames.includes(job.name) && (job.status === "PENDING" || job.status === "RUNNING"),
    )
    .reduce((sum, job) => sum + job.count, 0);
  const workers = ((await deps.homeTokens?.listForWorkspace(workspaceId)) ?? [])
    .filter((token) => !token.revokedAt)
    .map((token) => ({
      name: token.name,
      lastUsedAt: token.lastUsedAt,
      heartbeatAt: token.heartbeatAt ?? null,
      busy: token.heartbeat?.busy ?? null,
      runtimes: token.heartbeat?.runtimes ?? {},
      lastFailureCode: token.heartbeat?.lastFailureCode ?? null,
      online: token.heartbeatAt
        ? now.getTime() - token.heartbeatAt.getTime() < HOME_WORKER_ONLINE_MS
        : false,
    }));

  const failed =
    (await deps.jobStats?.listFailed({
      workspaceId,
      since: new Date(now.getTime() - NEEDS_ATTENTION_WINDOW_MS),
      take: 20,
    })) ?? [];
  const humanActions = Object.fromEntries(HUMAN_ACTION_KINDS.map((kind) => [kind, 0])) as Record<
    HumanActionKind,
    number
  >;
  for (const action of await listHumanActions(deps, {
    workspaceId,
    limit: 200,
    now,
  }))
    humanActions[action.kind] += 1;

  return {
    affiliate,
    production: { variantsByState },
    jobs: jobs.map(({ name, status, count }) => ({ name, status, count })),
    localAi: { queueDepth, workers },
    needsAttention: failed.map((job) => ({
      jobId: job.id,
      name: job.name,
      reason: job.terminalReason ?? "unknown",
      at: job.updatedAt,
    })),
    humanActions,
    generationPolicy: deps.generationPolicy,
    autonomyEnabled: deps.autonomyEnabled,
  };
};
