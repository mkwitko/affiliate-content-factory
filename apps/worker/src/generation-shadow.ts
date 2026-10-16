import type { WorkspaceId } from "@money-maker/contracts";
import { saoPauloMonth } from "@money-maker/core/costs/generation-settings";
import {
  DEFAULT_ROUTES,
  type GenerationRouteRepository,
} from "@money-maker/core/generation/route-repository";
import {
  orderRoutes,
  type RouteTask,
  type RunOutcome,
  routeHealth,
} from "@money-maker/core/generation/routing";

const RECENT_RUNS = 5;

/**
 * Shadow mode (spec 2026-10-14, rollout step 2): the route the router would pick for a task, next
 * to the one that really runs. Free credit and budget are assumed available here; the real
 * router (plan C2) reads them. Never throws.
 */
export const shadowChoice = async (
  routes: Pick<GenerationRouteRepository, "list" | "seed" | "recentRuns">,
  input: Readonly<{ workspaceId: WorkspaceId; task: RouteTask; actual: string; now: Date }>,
): Promise<Readonly<{ chosen: string | null; actual: string; agrees: boolean }>> => {
  try {
    // Seeding only adds missing routes, so new defaults reach existing workspaces.
    await routes.seed(input.workspaceId, DEFAULT_ROUTES);
    const known = await routes.list(input.workspaceId);
    const runs = await routes.recentRuns(input.workspaceId, RECENT_RUNS);
    const chosen =
      orderRoutes({
        task: input.task,
        routes: known,
        health: (route) =>
          routeHealth(
            runs.filter((run) => run.routeId === route.id),
            input.now,
          ),
        freeCreditLeft: () => true,
        paidAllowed: () => true,
      })[0]?.id ?? null;
    return { chosen, actual: input.actual, agrees: chosen === input.actual };
  } catch {
    return { chosen: null, actual: input.actual, agrees: false };
  }
};

/** A clip job's failure code as a run outcome; budget refusals pause the route until next month. */
export const clipRunOutcome = (
  code: string,
  now: Date,
): Readonly<{ outcome: RunOutcome; retryAfter?: Date }> => {
  if (code === "ok") return { outcome: "ok" };
  if (code.startsWith("clip_check_failed:")) return { outcome: "gate_failed" };
  if (code.startsWith("budget_"))
    return { outcome: "quota_exhausted", retryAfter: saoPauloMonth(now).endsAt };
  return { outcome: "technical_failure" };
};
