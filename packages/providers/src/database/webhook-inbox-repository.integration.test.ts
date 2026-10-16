import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { PrismaWebhookInboxRepository } from "./webhook-inbox-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaWebhookInboxRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaWebhookInboxRepository;

  beforeEach(async () => {
    if (!databaseUrl) return;
    client ??= createDatabaseClient(databaseUrl);
    repository ??= new PrismaWebhookInboxRepository(client);
    await client.webhookInbox.deleteMany();
    await client.publicationAttempt.deleteMany();
    await client.contentApproval.deleteMany();
    await client.contentVariant.deleteMany();
    await client.contentItem.deleteMany();
    await client.channel.deleteMany();
    await client.commercialFact.deleteMany();
    await client.commercialSnapshot.deleteMany();
    await client.offer.deleteMany();
    await client.niche.deleteMany();
    await client.secretRecord.deleteMany();
    await client.auditEvent.deleteMany();
    await client.providerConnection.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => client?.$disconnect());

  it("deduplicates a delivery key and keeps tenant records isolated", async () => {
    if (!client) return;
    const first = await client.workspace.create({ data: { name: "Webhook first" } });
    const second = await client.workspace.create({ data: { name: "Webhook second" } });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: first.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: "secret://webhook/first",
        accountId: "account-first",
      },
    });
    const input = {
      deliveryKey: "delivery-1",
      workspaceId: parseWorkspaceId(first.id),
      connectionId: connection.id,
      eventType: "social.post.result.created",
      providerResourceId: "attempt-1",
    };
    await expect(repository.createIfAbsent(input)).resolves.toEqual({ created: true });
    await expect(repository.createIfAbsent(input)).resolves.toEqual({ created: false });
    await expect(
      repository.createIfAbsent({
        ...input,
        workspaceId: parseWorkspaceId(second.id),
        connectionId: connection.id,
      }),
    ).rejects.toThrow();
  });
});
