import type { WorkspaceId } from "@money-maker/contracts";
import { type GenerationRoute, type GenerationRun, type RouteTask, routeId } from "./routing.js";

export type RecordedRun = GenerationRun &
  Readonly<{
    workspaceId: WorkspaceId;
    task: RouteTask;
    durationMs: number | null;
    detail: string | null;
  }>;

export interface GenerationRouteRepository {
  /** Routes with pass and run counts of the last 30 days from the run log. */
  list(workspaceId: WorkspaceId): Promise<readonly GenerationRoute[]>;
  /** Inserts the routes that do not exist yet; never changes an existing one. */
  seed(workspaceId: WorkspaceId, routes: readonly GenerationRoute[]): Promise<void>;
  recordRun(run: RecordedRun): Promise<void>;
  /** Owner decision on one route; null when the route does not exist in the workspace. */
  update(
    workspaceId: WorkspaceId,
    id: string,
    patch: Readonly<{ state?: GenerationRoute["state"]; ownerRank?: number | null }>,
  ): Promise<GenerationRoute | null>;
  /** Newest first, at most `limit` per route. */
  recentRuns(workspaceId: WorkspaceId, limit: number): Promise<readonly GenerationRun[]>;
}

const productionRoute = (
  task: RouteTask,
  model: string,
  executor: string,
  cost: GenerationRoute["cost"],
  provider: string | null,
  state: GenerationRoute["state"] = "qualified",
): GenerationRoute => ({
  id: routeId(task, model, executor),
  task,
  model,
  executor,
  cost,
  provider,
  state,
  ownerRank: null,
  passCount: 0,
  runCount: 0,
  costPerUnitMinor: null,
});

/**
 * Today's production paths, qualified because they are the ones in use, plus the cloud fallback
 * routes as candidates. Seeding only adds missing routes, so new defaults reach existing
 * workspaces without touching a route the owner or qualification changed.
 */
export const DEFAULT_ROUTES: readonly GenerationRoute[] = Object.freeze([
  productionRoute("image.offer_scene", "flux-2-klein-4b", "home_worker", "always_free", null),
  productionRoute("vision.qa", "qwen3-vl-4b", "home_worker", "always_free", null),
  productionRoute("llm.copy", "qwen3.5-9b", "home_worker", "always_free", null),
  productionRoute("llm.director", "qwen3.5-9b", "home_worker", "always_free", null),
  productionRoute("asr.ptbr", "parakeet-tdt-0.6b-v3", "home_worker", "always_free", null),
  productionRoute("image.scene_plate", "flux-1-schnell", "workers_ai", "always_free", null),
  productionRoute("video.i2v", "wan2.2-i2v-a14b", "modal", "credit", "modal"),
  // Cloud fallback while the desktop is off (plan C2): candidates until qualification (plan B).
  productionRoute(
    "image.offer_scene",
    "workers-ai:flux-2-klein-4b",
    "cloud_worker",
    "always_free",
    null,
    "candidate",
  ),
  productionRoute(
    "vision.qa",
    "vercel:alibaba/qwen3-vl-instruct",
    "cloud_worker",
    "credit",
    "vercel_ai_gateway",
    "candidate",
  ),
  productionRoute(
    "llm.copy",
    "vercel:alibaba/qwen3.8-flash",
    "cloud_worker",
    "credit",
    "vercel_ai_gateway",
    "candidate",
  ),
]);
