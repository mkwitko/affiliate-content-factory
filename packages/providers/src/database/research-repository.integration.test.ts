import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createResearchSnapshot } from "@money-maker/core/research/research-snapshot";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaResearchRepository } from "./research-repository.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
integration("PrismaResearchRepository", () => {
  let client: DatabaseClient;
  let repository: PrismaResearchRepository;
  beforeAll(() => {
    if (databaseUrl) {
      client = createDatabaseClient(databaseUrl);
      repository = new PrismaResearchRepository(client);
    }
  });
  beforeEach(async () => {
    if (!client) return;
    await client.researchObservation.deleteMany();
    await client.researchSnapshot.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });
  afterAll(async () => {
    await client?.$disconnect();
  });
  it("scopes duplicate hashes by workspace", async () => {
    const first = await client.workspace.create({ data: { name: "First" } });
    const second = await client.workspace.create({ data: { name: "Second" } });
    const user = await client.user.create({ data: { email: "research@example.com" } });
    const snapshot = createResearchSnapshot({
      workspaceId: parseWorkspaceId(first.id),
      actorId: parseUserId(user.id),
      provider: "vidiq",
      query: "x",
      locale: "pt-BR",
      observedAt: new Date("2026-09-21"),
      expiresAt: new Date("2026-09-22"),
      observations: [{ key: "trend", value: "x", sourceUrl: "https://vidiq.example/x" }],
    });
    await repository.create(snapshot);
    await expect(
      repository.findByHash({
        workspaceId: parseWorkspaceId(second.id),
        hash: snapshot.contentHash,
      }),
    ).resolves.toBeNull();
  });
});
