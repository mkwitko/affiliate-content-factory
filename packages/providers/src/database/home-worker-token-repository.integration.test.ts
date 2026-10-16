import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "./client.js";
import { PrismaHomeWorkerTokenRepository } from "./home-worker-token-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaHomeWorkerTokenRepository", () => {
  let client: DatabaseClient;
  beforeAll(async () => {
    const api = await import("./client.js");
    client = api.createDatabaseClient(databaseUrl as string);
  });
  afterAll(async () => {
    await client?.$disconnect();
  });

  const workspace = async () => {
    const id = randomUUID();
    await client.workspace.create({ data: { id, name: `ws ${id}` } });
    return parseWorkspaceId(id);
  };

  it("stores hashes, scopes listing and revocation by workspace", async () => {
    const repo = new PrismaHomeWorkerTokenRepository(client);
    const mine = await workspace();
    const other = await workspace();
    const token = await repo.create({
      id: randomUUID(),
      workspaceId: mine,
      name: "desktop",
      tokenHash: randomUUID(),
      prefix: "mmhw_abcdef",
      capabilities: ["visual_qa", "scene_director"],
      createdById: randomUUID(),
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    });
    await expect(repo.findByHash(token.tokenHash)).resolves.toMatchObject({
      id: token.id,
      capabilities: ["visual_qa", "scene_director"],
    });
    await expect(repo.listForWorkspace(other)).resolves.toEqual([]);
    await expect(
      repo.revoke({ workspaceId: other, id: token.id, at: new Date() }),
    ).resolves.toBeNull();
    await repo.touch({ id: token.id, at: new Date("2026-10-01T00:00:00Z") });
    const revoked = await repo.revoke({ workspaceId: mine, id: token.id, at: new Date() });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(revoked?.lastUsedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    await expect(
      repo.revoke({ workspaceId: mine, id: token.id, at: new Date() }),
    ).resolves.toBeNull();
  });
});
