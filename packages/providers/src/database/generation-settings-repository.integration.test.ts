import { parseWorkspaceId } from "@money-maker/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { PrismaGenerationSettingsRepository } from "./generation-settings-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaGenerationSettingsRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaGenerationSettingsRepository;
  const workspaceId = parseWorkspaceId("82a6b5ba-e755-4417-8722-a0b0ba82d551");

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaGenerationSettingsRepository(client);
  });
  beforeEach(async () => {
    await client.generationSettings.deleteMany();
    await client.workspace.deleteMany();
    await client.workspace.create({ data: { id: workspaceId, name: "w" } });
  });
  afterAll(async () => {
    await client?.$disconnect();
  });

  it("returns null before the owner sets anything, then the stored settings", async () => {
    expect(await repository.get(workspaceId)).toBeNull();
    await repository.put(workspaceId, {
      monthlyCapMinor: 5_000,
      freeCredits: { modal: { amountMinor: 3_000, currency: "USD" } },
    });
    await repository.put(workspaceId, {
      monthlyCapMinor: 7_000,
      freeCredits: { modal: { amountMinor: 3_000, currency: "USD" } },
    });
    expect(await repository.get(workspaceId)).toEqual({
      monthlyCapMinor: 7_000,
      freeCredits: { modal: { amountMinor: 3_000, currency: "USD" } },
    });
  });

  it("drops a stored credit of an unknown provider or a malformed one instead of trusting it", async () => {
    await client.generationSettings.create({
      data: {
        workspaceId,
        monthlyCapMinor: 1_000,
        freeCredits: { other: { amountMinor: 1, currency: "USD" }, modal: { amountMinor: -5 } },
      },
    });
    expect(await repository.get(workspaceId)).toEqual({ monthlyCapMinor: 1_000, freeCredits: {} });
  });
});
