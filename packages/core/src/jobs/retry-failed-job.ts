import type { WorkspaceId } from "@money-maker/contracts";
import type { UserId } from "@money-maker/contracts";
import type { AuditPort } from "../audit/audit-port.js";
import type { ContentRepository } from "../content/content-repository.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import type { JobQueue } from "./job.js";
import type { FailedJob, JobStats } from "./job-stats.js";

/** Automatic-package steps the owner may retry; everything else stays a human decision. */
export const RETRYABLE_JOB_NAMES: readonly string[] = [
  "produce_offer_package",
  "draft_offer_copy",
  "generate_offer_scenes",
  "check_scene_fidelity",
  "render_creatives",
  "render_reel",
];

export const FAILED_JOB_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type RetryFailedJobDeps = Readonly<{
  jobStats: Pick<JobStats, "listFailed">;
  jobQueue: Pick<JobQueue, "revive">;
  audit: AuditPort;
}>;

export type RetryFailedJobResult = "retried" | "not_found" | "not_retryable";

const listRetryable = async (
  jobStats: Pick<JobStats, "listFailed">,
  workspaceId: WorkspaceId,
  now: Date,
): Promise<FailedJob[]> =>
  (
    await jobStats.listFailed({
      workspaceId,
      since: new Date(now.getTime() - FAILED_JOB_WINDOW_MS),
      take: 100,
    })
  ).filter((job) => RETRYABLE_JOB_NAMES.includes(job.name));

export const retryFailedJob = async (
  deps: RetryFailedJobDeps,
  input: Readonly<{ workspaceId: WorkspaceId; jobId: string; actorUserId: UserId; now: Date }>,
): Promise<RetryFailedJobResult> => {
  const { workspaceId, jobId } = input;
  const failed = await deps.jobStats.listFailed({
    workspaceId,
    since: new Date(input.now.getTime() - FAILED_JOB_WINDOW_MS),
    take: 100,
  });
  const job = failed.find((entry) => entry.id === jobId);
  if (!job) return "not_found";
  if (!RETRYABLE_JOB_NAMES.includes(job.name) || !deps.jobQueue.revive) return "not_retryable";
  if (!(await deps.jobQueue.revive({ workspaceId, jobId }))) return "not_retryable";
  await deps.audit.record({
    action: "job.retried",
    workspaceId,
    actorUserId: input.actorUserId,
    targetType: "job",
    targetId: jobId,
    metadata: { name: job.name, previousReason: job.terminalReason ?? "unknown" },
  });
  return "retried";
};

export type RetryableFailedJob = Readonly<{
  jobId: string;
  name: string;
  reason: string;
  at: Date;
  contentItemId: string | null;
  title: string | null;
}>;

/** Retryable failed jobs of the last 14 days, newest first, max 50, with the post title. */
export const listRetryableFailedJobs = async (
  deps: Readonly<{
    jobStats: Pick<JobStats, "listFailed">;
    content: Pick<ContentRepository, "findContentItemForWorkspace" | "findVariantForWorkspace">;
    offers: Pick<OfferRepository, "findForWorkspace">;
  }>,
  input: Readonly<{ workspaceId: WorkspaceId; now: Date }>,
): Promise<RetryableFailedJob[]> => {
  const { workspaceId } = input;
  const jobs = (await listRetryable(deps.jobStats, workspaceId, input.now)).slice(0, 50);
  const result: RetryableFailedJob[] = [];
  for (const job of jobs) {
    const ids = job.identifiers ?? {};
    let contentItemId = ids.contentItemId ?? null;
    if (!contentItemId && ids.sourceVariantId)
      contentItemId =
        (
          await deps.content.findVariantForWorkspace({
            workspaceId,
            variantId: ids.sourceVariantId,
          })
        )?.contentItemId ?? null;
    let title: string | null = null;
    if (contentItemId)
      title =
        (await deps.content.findContentItemForWorkspace({ workspaceId, contentItemId }))?.title ??
        null;
    else if (ids.offerId)
      title =
        (await deps.offers.findForWorkspace({ workspaceId, offerId: ids.offerId }))?.title ?? null;
    result.push({
      jobId: job.id,
      name: job.name,
      reason: job.terminalReason ?? "unknown",
      at: job.updatedAt,
      contentItemId,
      title,
    });
  }
  return result;
};
