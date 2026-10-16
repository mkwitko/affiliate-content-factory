import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { changePublicationPolicy } from "@money-maker/core/workspaces/publication-policy";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaPublicationPolicyRepository } from "./publication-policy-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaPublicationPolicyRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaPublicationPolicyRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaPublicationPolicyRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.publicationPolicy.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("defaults and updates policies independently per workspace", async () => {
    const first = await client.workspace.create({ data: { name: "First workspace" } });
    const second = await client.workspace.create({ data: { name: "Second workspace" } });
    const firstId = parseWorkspaceId(first.id);
    const secondId = parseWorkspaceId(second.id);

    const firstPolicy = await repository.findForWorkspace(firstId);
    const secondPolicy = await repository.findForWorkspace(secondId);
    expect(firstPolicy.mode).toBe("manual");
    expect(secondPolicy.mode).toBe("manual");
    expect(
      await repository.update(changePublicationPolicy(firstPolicy, "policy_based")),
    ).toMatchObject({
      workspaceId: firstId,
      mode: "policy_based",
      version: 2,
    });
    await expect(repository.findForWorkspace(secondId)).resolves.toMatchObject({
      mode: "manual",
      version: 1,
    });
  });

  it("round-trips allow-lists and ignores malformed stored JSON", async () => {
    const workspace = await client.workspace.create({ data: { name: "Lists" } });
    const id = parseWorkspaceId(workspace.id);
    const current = await repository.findForWorkspace(id);
    expect(current.allowedFormats).toBeUndefined();
    const saved = await repository.update(
      changePublicationPolicy(current, "policy_based", {
        allowedFormats: ["carousel", "reel_slides"],
        evidenceMaxAgeDays: 7,
      }),
    );
    expect(saved).toMatchObject({
      allowedFormats: ["carousel", "reel_slides"],
      evidenceMaxAgeDays: 7,
    });
    await client.publicationPolicy.update({
      where: { workspaceId: id },
      data: { allowLists: { allowedFormats: "carousel", allowedNiches: [1] } },
    });
    const malformed = await repository.findForWorkspace(id);
    expect(malformed.allowedFormats).toBeUndefined();
    expect(malformed.allowedNiches).toBeUndefined();
  });
});
