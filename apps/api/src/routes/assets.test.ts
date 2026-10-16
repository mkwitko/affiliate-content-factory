import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const asset = (overrides: Partial<Asset>): Asset => ({
  id: "asset-1",
  workspaceId,
  objectKey: "k",
  checksum: "c",
  mimeType: "image/png",
  width: 400,
  height: 400,
  provenance: "operator_upload",
  license: "Owned",
  commercialUse: true,
  state: "active",
  ...overrides,
});

const build = (found: Asset | null) =>
  buildApp({
    invitation: {} as ApiDependencies["invitation"],
    workspaces: {} as ApiDependencies["workspaces"],
    authenticate: async () => null,
    assetRepository: { findForWorkspace: async () => found } as unknown as AssetRepository,
    assetStore: {
      createDownload: async ({ assetId }: { assetId: string }) => ({
        url: `https://r2.example.com/${assetId}?sig=1`,
      }),
    } as unknown as AssetStore,
  });

describe("GET /v1/public/workspaces/:workspaceId/assets/:assetId", () => {
  const url = `/v1/public/workspaces/${workspaceId}/assets/asset-1`;

  it("redirects a brand asset to its signed download without authentication", async () => {
    const app = build(asset({ metadata: { role: "logo", label: "Casa" } }));
    await app.ready();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://r2.example.com/asset-1?sig=1");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("redirects an explainer scene preview so the operator can open it from chat", async () => {
    const app = build(asset({ metadata: { role: "scene_preview", storyboardId: "b1" } }));
    await app.ready();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
  });

  it("redirects public marketplace photo copies", async () => {
    for (const role of ["listing_picture", "canonical_product"]) {
      const app = build(asset({ metadata: { role } }));
      await app.ready();
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
    }
  });

  it("hides every asset that is not an active public role", async () => {
    for (const found of [
      null,
      asset({ metadata: { role: "operator_note" } }),
      asset({ metadata: { role: "character" }, state: "pending" }),
      asset({}),
    ]) {
      const app = build(found);
      await app.ready();
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});
