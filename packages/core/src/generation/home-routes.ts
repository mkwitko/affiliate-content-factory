import type { WorkspaceId } from "@money-maker/contracts";
import type { GenerationRouteRepository } from "./route-repository.js";
import { type RouteTask, type RunOutcome, routeId } from "./routing.js";

/** The desktop's home worker jobs and the route each one runs on (executor `home_worker`). */
const HOME_JOB_ROUTES: Readonly<Record<string, Readonly<{ task: RouteTask; model: string }>>> =
  Object.freeze({
    generate_offer_scenes: { task: "image.offer_scene", model: "flux-2-klein-4b" },
    check_scene_fidelity: { task: "vision.qa", model: "qwen3-vl-4b" },
    review_frames: { task: "vision.qa", model: "qwen3-vl-4b" },
    draft_offer_copy: { task: "llm.copy", model: "qwen3.5-9b" },
    check_narration: { task: "asr.ptbr", model: "parakeet-tdt-0.6b-v3" },
    direct_scenes: { task: "llm.director", model: "qwen3.5-9b" },
  });

/** The VM's own home worker for cloud routes (plan C2) runs these models instead. */
const CLOUD_JOB_MODELS: Readonly<Record<string, string>> = Object.freeze({
  generate_offer_scenes: "workers-ai:flux-2-klein-4b",
  check_scene_fidelity: "vercel:alibaba/qwen3-vl-instruct",
  review_frames: "vercel:alibaba/qwen3-vl-instruct",
  draft_offer_copy: "vercel:alibaba/qwen3.8-flash",
});
export type HomeExecutor = "home_worker" | "cloud_worker";
/** Token name of the cloud worker the VM issues for itself; anything else is a home machine. */
export const CLOUD_WORKER_TOKEN_NAME = "Cloud worker (VM)";
export const executorOfToken = (token: Readonly<{ name: string }>): HomeExecutor =>
  token.name === CLOUD_WORKER_TOKEN_NAME ? "cloud_worker" : "home_worker";

export const homeJobRoute = (
  jobName: string,
  executor: HomeExecutor = "home_worker",
): Readonly<{ task: RouteTask; model: string }> | null => {
  const route = HOME_JOB_ROUTES[jobName];
  if (!route) return null;
  if (executor === "home_worker") return route;
  const model = CLOUD_JOB_MODELS[jobName];
  return model ? { task: route.task, model } : null;
};

const QUOTA_PAUSE_MS = 60 * 60 * 1000;

/**
 * Records one desktop execution on its route. Never throws: a run log outage must not fail the
 * task it describes (the router then just sees fewer runs).
 */
export const recordHomeRun = async (
  routes: Pick<GenerationRouteRepository, "recordRun"> | undefined,
  input: Readonly<{
    workspaceId: WorkspaceId;
    jobName: string;
    executor?: HomeExecutor;
    outcome: Exclude<RunOutcome, "quota_exhausted"> | "failed";
    detail: string | null;
    now: Date;
  }>,
): Promise<void> => {
  const executor = input.executor ?? "home_worker";
  const route = homeJobRoute(input.jobName, executor);
  if (!routes || !route) return;
  // An exhausted free tier (quota_*) or a prepaid balance at zero (HTTP 402) pauses the route.
  const quota = input.outcome === "failed" && /quota|_http_402\b/i.test(input.detail ?? "");
  const outcome: RunOutcome = quota
    ? "quota_exhausted"
    : input.outcome === "failed"
      ? "technical_failure"
      : input.outcome;
  await routes
    .recordRun({
      workspaceId: input.workspaceId,
      routeId: routeId(route.task, route.model, executor),
      task: route.task,
      outcome,
      at: input.now,
      ...(quota ? { retryAfter: new Date(input.now.getTime() + QUOTA_PAUSE_MS) } : {}),
      durationMs: null,
      detail: input.detail,
    })
    .catch(() => undefined);
};
