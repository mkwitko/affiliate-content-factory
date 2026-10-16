import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createChannel } from "@money-maker/core/channels/channel";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaChannelRepository } from "./channel-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaChannelRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaChannelRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaChannelRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.contentVariant.deleteMany();
    await client.channel.deleteMany();
    await client.providerConnection.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("does not reveal a channel through another workspace", async () => {
    const firstWorkspace = await client.workspace.create({ data: { name: "First workspace" } });
    const secondWorkspace = await client.workspace.create({ data: { name: "Second workspace" } });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: firstWorkspace.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "secret://workspace/channel-test",
        accountId: "default",
      },
    });
    const channel = createChannel({
      id: "channel-1",
      workspaceId: parseWorkspaceId(firstWorkspace.id),
      connection: {
        id: connection.id,
        workspaceId: parseWorkspaceId(firstWorkspace.id),
        provider: "post_for_me",
        mode: "api_key",
        secretReference: connection.secretReference,
        accountId: connection.accountId,
        status: "active",
      },
      kind: "threads",
    });

    await repository.create(channel);
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId(secondWorkspace.id),
        channelId: channel.id,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId(firstWorkspace.id),
        channelId: channel.id,
      }),
    ).resolves.toMatchObject({ connectionId: connection.id, kind: "threads" });
  });

  it("round-trips a tiktok_video channel", async () => {
    const workspace = await client.workspace.create({ data: { name: "TikTok workspace" } });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: workspace.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "secret://workspace/channel-tiktok-test",
        accountId: "default",
      },
    });
    const channel = createChannel({
      id: "channel-tiktok-1",
      workspaceId: parseWorkspaceId(workspace.id),
      connection: {
        id: connection.id,
        workspaceId: parseWorkspaceId(workspace.id),
        provider: "post_for_me",
        mode: "api_key",
        secretReference: connection.secretReference,
        accountId: connection.accountId,
        status: "active",
      },
      kind: "tiktok_video",
    });

    await repository.create(channel);
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId(workspace.id),
        channelId: channel.id,
      }),
    ).resolves.toMatchObject({ kind: "tiktok_video" });
  });
});
