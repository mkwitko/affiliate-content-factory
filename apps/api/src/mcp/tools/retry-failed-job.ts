import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { listRetryableFailedJobs, retryFailedJob } from "@money-maker/core/jobs/retry-failed-job";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const retryFailedJobInputSchema = z
  .object({ workspaceId: z.uuid(), jobId: z.uuid() })
  .strict();

export const listFailedJobsInputSchema = z.object({ workspaceId: z.uuid() }).strict();

export const retryFailedJobTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = retryFailedJobInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.jobStats || !deps.jobQueue || !deps.audit)
    throw new Error("Job retry dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const result = await retryFailedJob(
    { jobStats: deps.jobStats, jobQueue: deps.jobQueue, audit: deps.audit },
    { workspaceId, jobId: parsed.data.jobId, actorUserId: actorId, now: new Date() },
  );
  if (result === "not_found") return { ok: false, error: "NOT_FOUND" };
  if (result === "not_retryable") return { ok: false, error: "NOT_RETRYABLE" };
  return { ok: true, value: { retried: true } };
};

/** HTTP-only read for the web panel; the MCP surface already has get_autonomy_status. */
export const listFailedJobsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listFailedJobsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.jobStats || !deps.contentRepository || !deps.offerRepository)
    throw new Error("Failed job dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const jobs = await listRetryableFailedJobs(
    { jobStats: deps.jobStats, content: deps.contentRepository, offers: deps.offerRepository },
    { workspaceId, now: new Date() },
  );
  return {
    ok: true,
    value: { jobs: jobs.map((job) => ({ ...job, at: job.at.toISOString() })) },
  };
};
