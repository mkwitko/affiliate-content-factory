import { parseWorkerEnvironment } from "@money-maker/config";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { EnqueueJobInput } from "@money-maker/core/jobs/job";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PostgresJobQueue } from "@money-maker/providers/jobs/postgres-job-queue";
import { createGeneratePlatesJob } from "../handlers/generate-plates.js";
import { createReviewFramesJob } from "../handlers/review-frames.js";

const USAGE =
  "usage: enqueue-local-ai-job.js generate_plates <workspaceId> <nicheId> | review_frames <workspaceId> <renderId>";

/**
 * The producer for local-AI jobs that no MCP tool enqueues (v2 slices 27 and 29). Run it
 * against the queue a `local_ai` worker claims from; it only writes one job row.
 */
export const localAiJobFor = (args: readonly string[], day: string): EnqueueJobInput => {
  const [kind, workspace, id] = args;
  if (!workspace || !id) throw new Error(USAGE);
  const workspaceId = parseWorkspaceId(workspace);
  if (kind === "generate_plates") return createGeneratePlatesJob({ workspaceId, nicheId: id, day });
  if (kind === "review_frames") return createReviewFramesJob({ workspaceId, renderId: id });
  throw new Error(USAGE);
};

const main = async (): Promise<void> => {
  const job = localAiJobFor(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  const client = createDatabaseClient(parseWorkerEnvironment(process.env).DATABASE_URL);
  try {
    const queued = await new PostgresJobQueue(client).enqueue(job);
    console.log(JSON.stringify({ jobId: queued.id, name: queued.name }));
  } finally {
    await client.$disconnect();
  }
};

if (process.argv[1]?.endsWith("enqueue-local-ai-job.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "enqueue failed");
    process.exitCode = 1;
  });
}
