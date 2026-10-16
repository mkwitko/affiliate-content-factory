import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { McpDependencies } from "../server.js";
import { listAssetsTool } from "./list-assets.js";
import { reviewHomeWorkerAssetTool } from "./review-home-worker-asset.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const held = (overrides: Partial<Asset> = {}): Asset => ({
  id: "plate-1",
  workspaceId,
  objectKey: "k",
  checksum: "c".repeat(64),
  commercialUse: null,
  creator: "local:z-image-turbo",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  provenance: "generated",
  license: "Apache-2.0 (declared local:z-image-turbo, home worker mmhw_abcdef)",
  metadata: { homeWorker: { status: "pending_review", tokenId: "t1", jobId: "j1" } },
  state: "pending_review",
  ...overrides,
});

const fixture = (asset: Asset, role: "owner" | "operator" | "reviewer" = "owner") => {
  let current = asset;
  const assetRepository = {
    findForWorkspace: async () => current,
    listForWorkspace: vi.fn(async (_: unknown, state?: Asset["state"]) =>
      current.state === (state ?? "active") ? [current] : [],
    ),
    updateMetadata: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => {
      current = { ...current, metadata: { ...current.metadata, ...patch } };
      return current;
    }),
    updateRights: vi.fn(async ({ commercialUse }: { commercialUse: boolean | null }) => {
      current = { ...current, commercialUse };
      return current;
    }),
    updateState: vi.fn(async ({ state }: { state: Asset["state"] }) => {
      current = { ...current, state };
      return current;
    }),
  };
  const deps = {
    workspaces: {
      findMembership: async () => ({ workspaceId, userId, role, status: "active" as const }),
    },
    assetRepository,
    assetStore: { createDownload: async () => ({ method: "GET", url: "https://r2.example/p" }) },
    audit: { record: vi.fn(async () => undefined) },
  } as unknown as McpDependencies;
  return { deps, assetRepository, current: () => current };
};

describe("review_home_worker_asset (ADR 0012)", () => {
  it("lists held images with a preview link and approves one into a usable, licensed asset", async () => {
    const f = fixture(held());
    const listed = await listAssetsTool({ workspaceId, state: "pending_review" }, userId, f.deps);
    expect(listed).toMatchObject({
      ok: true,
      value: { assets: [{ id: "plate-1", previewUrl: "https://r2.example/p" }] },
    });
    const result = await reviewHomeWorkerAssetTool(
      { workspaceId, assetId: "plate-1", decision: "approve" },
      userId,
      f.deps,
    );
    expect(result).toEqual({
      ok: true,
      value: { assetId: "plate-1", state: "active", commercialUse: true },
    });
    expect(f.current().metadata?.homeWorker).toMatchObject({
      status: "approved",
      tokenId: "t1",
      reviewedBy: userId,
    });
    // Activation comes last, after rights and review are recorded.
    expect(f.assetRepository.updateState.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.assetRepository.updateRights.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("archives a rejected image without granting rights", async () => {
    const f = fixture(held());
    await expect(
      reviewHomeWorkerAssetTool(
        { workspaceId, assetId: "plate-1", decision: "reject" },
        userId,
        f.deps,
      ),
    ).resolves.toMatchObject({ ok: true, value: { state: "archived", commercialUse: null } });
    expect(f.assetRepository.updateRights).not.toHaveBeenCalled();
  });

  it("refuses assets that are not held home worker images, and reviewers", async () => {
    const active = fixture(held({ state: "active" }));
    await expect(
      reviewHomeWorkerAssetTool(
        { workspaceId, assetId: "plate-1", decision: "approve" },
        userId,
        active.deps,
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_CONTENT" });
    const upload = fixture(held({ metadata: {} }));
    await expect(
      reviewHomeWorkerAssetTool(
        { workspaceId, assetId: "plate-1", decision: "approve" },
        userId,
        upload.deps,
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_CONTENT" });
    const reviewer = fixture(held(), "reviewer");
    await expect(
      reviewHomeWorkerAssetTool(
        { workspaceId, assetId: "plate-1", decision: "approve" },
        userId,
        reviewer.deps,
      ),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
    expect(reviewer.assetRepository.updateState).not.toHaveBeenCalled();
  });
});
