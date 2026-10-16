import type { WorkspaceId } from "@money-maker/contracts";
import type {
  GenerationRouteRepository,
  RecordedRun,
} from "@money-maker/core/generation/route-repository";
import type {
  GenerationRoute,
  GenerationRun,
  RouteCost,
  RouteState,
  RouteTask,
  RunOutcome,
} from "@money-maker/core/generation/routing";
import type { DatabaseClient } from "./client.js";

const WINDOW_MS = 30 * 86_400_000;

export class PrismaGenerationRouteRepository implements GenerationRouteRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async list(workspaceId: WorkspaceId): Promise<readonly GenerationRoute[]> {
    const [routes, counts] = await Promise.all([
      this.client.generationRoute.findMany({ where: { workspaceId }, orderBy: { id: "asc" } }),
      this.client.generationRun.groupBy({
        by: ["routeId", "outcome"],
        where: {
          workspaceId,
          outcome: { in: ["ok", "gate_failed"] },
          createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
        },
        _count: { _all: true },
      }),
    ]);
    const count = (routeId: string, outcome: RunOutcome) =>
      counts.find((row) => row.routeId === routeId && row.outcome === outcome)?._count._all ?? 0;
    return routes.map((row) => ({
      id: row.id,
      task: row.task as RouteTask,
      model: row.model,
      executor: row.executor,
      cost: row.cost as RouteCost,
      provider: row.provider,
      state: row.state as RouteState,
      ownerRank: row.ownerRank,
      passCount: count(row.id, "ok"),
      runCount: count(row.id, "ok") + count(row.id, "gate_failed"),
      costPerUnitMinor: row.costPerUnitMinor,
    }));
  }

  public async seed(workspaceId: WorkspaceId, routes: readonly GenerationRoute[]): Promise<void> {
    await this.client.generationRoute.createMany({
      data: routes.map((route) => ({
        workspaceId,
        id: route.id,
        task: route.task,
        model: route.model,
        executor: route.executor,
        cost: route.cost,
        provider: route.provider,
        state: route.state,
        ownerRank: route.ownerRank,
        costPerUnitMinor: route.costPerUnitMinor,
      })),
      skipDuplicates: true,
    });
  }

  public async update(
    workspaceId: WorkspaceId,
    id: string,
    patch: Readonly<{ state?: RouteState; ownerRank?: number | null }>,
  ): Promise<GenerationRoute | null> {
    const updated = await this.client.generationRoute.updateMany({
      where: { workspaceId, id },
      data: {
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.ownerRank !== undefined ? { ownerRank: patch.ownerRank } : {}),
      },
    });
    if (updated.count === 0) return null;
    return (await this.list(workspaceId)).find((route) => route.id === id) ?? null;
  }

  public async recordRun(run: RecordedRun): Promise<void> {
    await this.client.generationRun.create({
      data: {
        workspaceId: run.workspaceId,
        routeId: run.routeId,
        task: run.task,
        outcome: run.outcome,
        retryAfter: run.retryAfter ?? null,
        durationMs: run.durationMs,
        detail: run.detail?.slice(0, 200) ?? null,
        createdAt: run.at,
      },
    });
  }

  public async recentRuns(
    workspaceId: WorkspaceId,
    limit: number,
  ): Promise<readonly GenerationRun[]> {
    const rows = await this.client.$queryRaw<
      { route_id: string; outcome: string; created_at: Date; retry_after: Date | null }[]
    >`SELECT route_id, outcome, created_at, retry_after FROM (
        SELECT route_id, outcome, created_at, retry_after,
          ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY created_at DESC) AS position
        FROM generation_runs WHERE workspace_id = ${workspaceId}::uuid
      ) ranked WHERE position <= ${limit} ORDER BY created_at DESC`;
    return rows.map((row) => ({
      routeId: row.route_id,
      outcome: row.outcome as RunOutcome,
      at: row.created_at,
      ...(row.retry_after ? { retryAfter: row.retry_after } : {}),
    }));
  }
}
