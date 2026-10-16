import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaUsageRepository } from "./usage-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaUsageRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaUsageRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaUsageRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.usageEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("sums events since a date for one workspace only", async () => {
    const first = await client.workspace.create({ data: { name: "First workspace" } });
    const second = await client.workspace.create({ data: { name: "Second workspace" } });
    const since = new Date(Date.now() - 60_000);
    await repository.record({
      workspaceId: parseWorkspaceId(first.id),
      provider: "cloudflare_workers_ai",
      unit: "neurons",
      quantity: 346,
      operation: "scene",
    });
    await repository.record({
      workspaceId: parseWorkspaceId(second.id),
      provider: "cloudflare_workers_ai",
      unit: "neurons",
      quantity: 173,
      operation: "scene",
    });
    await expect(
      repository.sum({
        workspaceId: parseWorkspaceId(first.id),
        provider: "cloudflare_workers_ai",
        unit: "neurons",
        since,
      }),
    ).resolves.toBe(346);
    await expect(
      repository.sum({
        workspaceId: parseWorkspaceId(second.id),
        provider: "cloudflare_workers_ai",
        unit: "neurons",
        since,
      }),
    ).resolves.toBe(173);
  });
});
