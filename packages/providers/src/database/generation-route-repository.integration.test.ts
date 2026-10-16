import { parseWorkspaceId } from "@money-maker/contracts";
import { DEFAULT_ROUTES } from "@money-maker/core/generation/route-repository";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { PrismaGenerationRouteRepository } from "./generation-route-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const clipRoute = DEFAULT_ROUTES.find((route) => route.task === "video.i2v");

integration("PrismaGenerationRouteRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaGenerationRouteRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaGenerationRouteRepository(client);
  });
  beforeEach(async () => {
    await client.generationRun.deleteMany();
    await client.generationRoute.deleteMany();
    await client.workspace.deleteMany();
  });
  afterAll(async () => {
    await client?.$disconnect();
  });
  const workspace = async () =>
    parseWorkspaceId((await client.workspace.create({ data: { name: "Routes" } })).id);
  const run = (
    workspaceId: ReturnType<typeof parseWorkspaceId>,
    outcome: "ok" | "gate_failed" | "technical_failure" | "quota_exhausted",
    at: Date,
  ) =>
    repository.recordRun({
      workspaceId,
      routeId: clipRoute?.id ?? "",
      task: "video.i2v",
      outcome,
      at,
      durationMs: 1_000,
      detail: null,
    });

  it("seeds missing routes only and keeps an owner's rank", async () => {
    const workspaceId = await workspace();
    await repository.seed(workspaceId, DEFAULT_ROUTES);
    await client.generationRoute.update({
      where: { workspaceId_id: { workspaceId, id: clipRoute?.id ?? "" } },
      data: { ownerRank: 1 },
    });
    await repository.seed(workspaceId, DEFAULT_ROUTES);
    const routes = await repository.list(workspaceId);
    expect(routes).toHaveLength(DEFAULT_ROUTES.length);
    expect(routes.find((route) => route.id === clipRoute?.id)?.ownerRank).toBe(1);
  });

  it("updates one route's state and rank, and reports a missing route as null", async () => {
    const workspaceId = await workspace();
    await repository.seed(workspaceId, DEFAULT_ROUTES);
    const updated = await repository.update(workspaceId, clipRoute?.id ?? "", {
      state: "demoted",
      ownerRank: 2,
    });
    expect(updated).toMatchObject({ state: "demoted", ownerRank: 2 });
    expect(await repository.update(workspaceId, "missing", { state: "qualified" })).toBeNull();
  });

  it("counts passes and runs of the last 30 days, per workspace, without technical or quota runs", async () => {
    const workspaceId = await workspace();
    const other = await workspace();
    await repository.seed(workspaceId, DEFAULT_ROUTES);
    const now = new Date();
    await run(workspaceId, "ok", now);
    await run(workspaceId, "gate_failed", now);
    await run(workspaceId, "technical_failure", now);
    await run(workspaceId, "quota_exhausted", now);
    await run(workspaceId, "ok", new Date(now.getTime() - 40 * 86_400_000));
    await run(other, "ok", now);
    const clip = (await repository.list(workspaceId)).find((route) => route.id === clipRoute?.id);
    expect(clip).toMatchObject({ passCount: 1, runCount: 2 });
  });

  it("returns at most the limit of recent runs per route, newest first", async () => {
    const workspaceId = await workspace();
    const base = Date.now();
    for (let i = 0; i < 5; i += 1) await run(workspaceId, "ok", new Date(base - i * 60_000));
    const recent = await repository.recentRuns(workspaceId, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.at.getTime()).toBe(base);
  });
});
