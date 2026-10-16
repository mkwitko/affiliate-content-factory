import type { UserId } from "@money-maker/contracts";
import { spendSummary } from "@money-maker/core/costs/generation-budget";
import {
  CLOUD_PROVIDERS,
  DEFAULT_GENERATION_SETTINGS,
  freeCreditPolicy,
  paidBudgetPolicy,
} from "@money-maker/core/costs/generation-settings";
import { DEFAULT_ROUTES } from "@money-maker/core/generation/route-repository";
import { orderRoutes, ROUTE_TASKS, routeHealth } from "@money-maker/core/generation/routing";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getGenerationRoutesInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const setGenerationRouteInputSchema = z
  .object({
    workspaceId: z.uuid(),
    routeId: z.string().trim().min(3).max(200),
    state: z.enum(["candidate", "qualifying", "qualified", "rejected", "demoted"]).optional(),
    /** 1 = best quality among free routes of the task; null clears the rank. */
    ownerRank: z.number().int().min(1).max(20).nullable().optional(),
  })
  .strict();

const RECENT_RUNS = 5;

/**
 * The router's order per task right now (spec 2026-10-14): which route each kind of generation
 * would try first, and why the others are out. Seeds today's production routes on first read.
 */
export const getGenerationRoutesTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getGenerationRoutesInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.generationRoutes || !deps.generationSettings || !deps.generationBudgetLedger)
    throw new Error("Generation routes are not configured.");
  const now = new Date();
  // Seeding only adds missing routes, so new defaults reach existing workspaces.
  await deps.generationRoutes.seed(workspaceId, DEFAULT_ROUTES);
  const routes = await deps.generationRoutes.list(workspaceId);
  const runs = await deps.generationRoutes.recentRuns(workspaceId, RECENT_RUNS);
  const settings = (await deps.generationSettings.get(workspaceId)) ?? DEFAULT_GENERATION_SETTINGS;
  const ledger = deps.generationBudgetLedger;
  const remaining = async (policy: ReturnType<typeof paidBudgetPolicy>) =>
    spendSummary(await ledger.list({ workspaceId, budgetKey: policy.key }), policy, now)
      .remainingMinor;
  const paidLeft = (await remaining(paidBudgetPolicy(settings, [], now))) > 0;
  const freeLeft = new Map<string, boolean>();
  for (const provider of CLOUD_PROVIDERS) {
    const credit = settings.freeCredits[provider];
    freeLeft.set(
      provider,
      credit ? (await remaining(freeCreditPolicy(provider, credit, now))) > 0 : false,
    );
  }
  const health = (route: (typeof routes)[number]) =>
    routeHealth(
      runs.filter((run) => run.routeId === route.id),
      now,
    );
  const tasks = ROUTE_TASKS.map((task) => {
    const ordered = orderRoutes({
      task,
      routes,
      health,
      freeCreditLeft: (provider) => freeLeft.get(provider) ?? false,
      paidAllowed: () => paidLeft,
    });
    const excluded = routes
      .filter((route) => route.task === task && !ordered.includes(route))
      .map((route) => ({
        id: route.id,
        reason: route.state !== "qualified" ? route.state : (health(route).reason ?? "no_budget"),
        passRate: route.runCount > 0 ? route.passCount / route.runCount : null,
        runs30d: route.runCount,
      }));
    return {
      task,
      order: ordered.map((route) => ({
        id: route.id,
        cost: route.cost,
        ownerRank: route.ownerRank,
        passRate: route.runCount > 0 ? route.passCount / route.runCount : null,
        runs30d: route.runCount,
      })),
      excluded,
    };
  }).filter((entry) => entry.order.length > 0 || entry.excluded.length > 0);
  return { ok: true, value: { tasks } };
};

/**
 * Owner decision on one route (spec 2026-10-14): put it in qualification (it runs while the
 * desktop is off and every output still passes the gates and the package review), qualify,
 * reject or demote it, or set its quality rank among free routes.
 */
export const setGenerationRouteTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = setGenerationRouteInputSchema.safeParse(input);
  if (!parsed.success || (parsed.data.state === undefined && parsed.data.ownerRank === undefined))
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  if (!deps.generationRoutes) throw new Error("Generation routes are not configured.");
  await deps.generationRoutes.seed(workspaceId, DEFAULT_ROUTES);
  const route = await deps.generationRoutes.update(workspaceId, parsed.data.routeId, {
    ...(parsed.data.state ? { state: parsed.data.state } : {}),
    ...(parsed.data.ownerRank !== undefined ? { ownerRank: parsed.data.ownerRank } : {}),
  });
  if (!route) return { ok: false, error: "NOT_FOUND" };
  await deps.audit?.record({
    action: "generation_route.updated",
    workspaceId,
    actorUserId: actorId,
    targetType: "GenerationRoute",
    targetId: route.id,
    metadata: { state: route.state, ownerRank: String(route.ownerRank ?? "") },
  });
  return {
    ok: true,
    value: { route: { id: route.id, state: route.state, ownerRank: route.ownerRank } },
  };
};
