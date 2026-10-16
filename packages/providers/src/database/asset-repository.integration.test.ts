import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createAsset } from "@money-maker/core/assets/asset";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaAssetRepository } from "./asset-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaAssetRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaAssetRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaAssetRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.publicationAttempt.deleteMany();
    await client.asset.deleteMany();
    await client.auditEvent.deleteMany();
    await client.workspace.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("scopes asset metadata to its workspace", async () => {
    const first = await client.workspace.create({ data: { name: "First workspace" } });
    const second = await client.workspace.create({ data: { name: "Second workspace" } });
    const result = createAsset({
      id: "asset-1",
      workspaceId: parseWorkspaceId(first.id),
      mimeType: "image/png",
      checksum: "sha256:test",
      width: 1080,
      height: 1920,
      provenance: "operator_upload",
      license: "operator-confirmed",
    });
    if (!result.ok) throw new Error("Asset fixture is invalid");

    await repository.create(result.asset);
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId(second.id),
        assetId: result.asset.id,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findForWorkspace({
        workspaceId: parseWorkspaceId(first.id),
        assetId: result.asset.id,
      }),
    ).resolves.toMatchObject({ objectKey: `workspaces/${first.id}/assets/asset-1` });
  });

  it("finds active assets by metadata only inside their workspace", async () => {
    const first = await client.workspace.create({ data: { name: "First workspace" } });
    const second = await client.workspace.create({ data: { name: "Second workspace" } });
    const result = createAsset({
      id: "scene-1",
      workspaceId: parseWorkspaceId(first.id),
      mimeType: "image/png",
      checksum: "sha256:scene",
      width: 1080,
      height: 1920,
      provenance: "generated",
      license: "scene-test",
      metadata: { role: "scene", nicheId: "n1" },
    });
    if (!result.ok) throw new Error("Asset fixture is invalid");
    await repository.create(result.asset);
    await repository.updateState({
      workspaceId: parseWorkspaceId(first.id),
      assetId: result.asset.id,
      state: "active",
    });
    await expect(
      repository.findByMetadata({
        workspaceId: parseWorkspaceId(first.id),
        role: "scene",
        key: "nicheId",
        value: "n1",
      }),
    ).resolves.toMatchObject({ id: "scene-1", metadata: { role: "scene", nicheId: "n1" } });
    await expect(
      repository.findByMetadata({
        workspaceId: parseWorkspaceId(second.id),
        role: "scene",
        key: "nicheId",
        value: "n1",
      }),
    ).resolves.toBeNull();
  });

  it("hides stage_artifact assets from the workspace list but keeps other assets", async () => {
    const workspace = await client.workspace.create({ data: { name: "Cache workspace" } });
    const workspaceId = parseWorkspaceId(workspace.id);
    const image = (id: string, metadata?: Record<string, unknown>) => {
      const result = createAsset({
        id,
        workspaceId,
        mimeType: "image/png",
        checksum: `sha256:${id}`,
        width: 10,
        height: 10,
        provenance: "generated",
        license: "internal",
        ...(metadata ? { metadata } : {}),
      });
      if (!result.ok) throw new Error("fixture");
      return result.asset;
    };
    await repository.create(image("visible-null")); // metadata undefined -> NULL column
    await repository.create(image("visible-norole", { sceneKey: "x" })); // metadata without role
    await repository.create(image("visible-logo", { role: "logo" }));
    await repository.create({
      id: "cache-1",
      workspaceId,
      objectKey: `workspaces/${workspaceId}/assets/cache-1`,
      checksum: "sha256:cache",
      mimeType: "audio/wav",
      width: 0,
      height: 0,
      provenance: "generated",
      commercialUse: null,
      license: "internal",
      metadata: { role: "stage_artifact", stage: "tts", cacheKey: "abc" },
      state: "pending",
    });
    for (const assetId of ["visible-null", "visible-norole", "visible-logo", "cache-1"])
      await repository.updateState({ workspaceId, assetId, state: "active" });

    const listed = await repository.listForWorkspace(workspaceId);
    expect(listed.map((asset) => asset.id).sort()).toEqual([
      "visible-logo",
      "visible-norole",
      "visible-null",
    ]);

    const byKey = await repository.listByMetadata({
      workspaceId,
      role: "stage_artifact",
      key: "cacheKey",
      value: "abc",
    });
    expect(byKey.map((asset) => asset.id)).toEqual(["cache-1"]);
  });
});
