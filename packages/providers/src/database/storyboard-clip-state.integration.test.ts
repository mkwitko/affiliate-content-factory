import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { PrismaStoryboardRepository } from "./storyboard-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaStoryboardRepository clip state", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaStoryboardRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaStoryboardRepository(client);
  });
  beforeEach(async () => {
    if (client) await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE');
  });
  afterAll(async () => {
    if (!client) return;
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE');
    await client.$disconnect();
  });

  const fixture = async (label: string, renderer = "ai_clips") => {
    const workspace = await client.workspace.create({ data: { name: `Clips ${label}` } });
    const user = await client.user.create({
      data: { email: `clips-${label}-${randomUUID()}@example.com` },
    });
    const niche = await client.niche.create({
      data: {
        id: `niche-${label}`,
        workspaceId: workspace.id,
        name: "Home",
        audience: "Everyone",
        problem: "Clutter",
        editorialVoice: "Plain",
        languages: ["pt-BR"],
        monetizationHypothesis: "none",
        kind: "MEDIA",
      },
    });
    const item = await client.contentItem.create({
      data: {
        id: `item-${label}`,
        workspaceId: workspace.id,
        nicheId: niche.id,
        title: "Clip item",
        sourceFactKeys: [],
        creativeOpinion: "none",
      },
    });
    const script = await client.contentScript.create({
      data: {
        id: `script-${label}`,
        workspaceId: workspace.id,
        contentItemId: item.id,
        version: 1,
        body: "Hello world",
        language: "en",
        claims: [],
        beats: [],
        checksum: "a".repeat(64),
        actorId: user.id,
      },
    });
    const board = await client.videoStoryboard.create({
      data: {
        id: `board-${label}`,
        workspaceId: workspace.id,
        contentItemId: item.id,
        scriptId: script.id,
        version: 1,
        scenes: [],
        voiceId: "pf_dora",
        canvas: "portrait",
        renderer,
        checksum: "c".repeat(64),
        actorId: user.id,
      },
    });
    return { workspaceId: parseWorkspaceId(workspace.id), storyboardId: board.id };
  };

  it("starts empty, writes one scene at a time and keeps the others", async () => {
    const { workspaceId, storyboardId } = await fixture("a");
    expect(await repository.read({ workspaceId, storyboardId })).toEqual({});
    await repository.write({
      workspaceId,
      storyboardId,
      sceneIndex: 1,
      state: { status: "submitted", providerTaskId: "t1", attempts: 1 },
    });
    await repository.write({
      workspaceId,
      storyboardId,
      sceneIndex: 2,
      state: { status: "queued", attempts: 0 },
    });
    await repository.write({
      workspaceId,
      storyboardId,
      sceneIndex: 1,
      state: { status: "ready", assetId: "asset-1", attempts: 1 },
    });
    expect(await repository.read({ workspaceId, storyboardId })).toEqual({
      "1": { status: "ready", assetId: "asset-1", attempts: 1 },
      "2": { status: "queued", attempts: 0 },
    });
  });
  it("never reads or writes another workspace's state", async () => {
    const a = await fixture("a");
    const b = await fixture("b");
    await repository.write({ ...a, sceneIndex: 1, state: { status: "queued", attempts: 0 } });
    expect(
      await repository.read({ workspaceId: b.workspaceId, storyboardId: a.storyboardId }),
    ).toEqual({});
    await repository.write({
      workspaceId: b.workspaceId,
      storyboardId: a.storyboardId,
      sceneIndex: 1,
      state: { status: "failed", attempts: 9 },
    });
    expect((await repository.read(a))["1"]?.status).toBe("queued");
  });
  it("accepts the ai_clips renderer value in the CHECK constraint", async () => {
    await expect(fixture("c", "ai_clips")).resolves.toBeDefined();
    await expect(fixture("d", "nonsense")).rejects.toThrow();
  });
});
