import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaProviderConnectionRepository } from "./provider-connection-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaProviderConnectionRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaProviderConnectionRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaProviderConnectionRepository(client);
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

  const createWorkspace = async (name: string) => {
    const workspace = await client.workspace.create({ data: { name } });
    return parseWorkspaceId(workspace.id);
  };

  const connection = (
    workspaceId: ProviderConnection["workspaceId"],
    id: string,
  ): ProviderConnection => ({
    id,
    workspaceId,
    provider: "post_for_me",
    mode: "api_key",
    status: "active",
    secretReference: `secret://workspace/${workspaceId}/connection/${id}`,
    accountId: "default",
  });

  it("denies cross-workspace lookup and normalizes duplicate account conflicts", async () => {
    const firstWorkspaceId = await createWorkspace("First workspace");
    const secondWorkspaceId = await createWorkspace("Second workspace");
    const first = connection(firstWorkspaceId, "58cfa418-8c9c-4cc2-8f3a-468d04bd5237");
    const duplicate = connection(firstWorkspaceId, "8a17e518-5492-447e-8a2b-87e47b46b241");

    await expect(repository.create(first)).resolves.toEqual({ ok: true, connection: first });
    await expect(
      repository.findForWorkspace({ workspaceId: secondWorkspaceId, connectionId: first.id }),
    ).resolves.toBeNull();
    await expect(repository.create(duplicate)).resolves.toEqual({
      ok: false,
      code: "duplicate_account",
    });
  });
});
