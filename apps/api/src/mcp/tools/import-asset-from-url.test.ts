import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { McpDependencies } from "../server.js";
import { importAssetFromUrlTool } from "./import-asset-from-url.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const setup = async () => {
  const photo = await sharp({
    create: { width: 500, height: 400, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(photo, { headers: { "content-type": "image/png" } })),
  );
  const puts: Parameters<AssetStore["putObject"]>[0][] = [];
  const created: Asset[] = [];
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner" as const,
        status: "active" as const,
      }),
      addMembership: async () => undefined,
    },
    assetRepository: {
      create: async (asset: Asset) => {
        created.push(asset);
        return asset;
      },
      updateState: async ({ state }: { state: Asset["state"] }) => ({ state }) as unknown as Asset,
    } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    assetStore: {
      putObject: async (input) => {
        puts.push(input);
      },
    } as AssetStore,
  };
  return { dependencies, puts, created };
};

const importArgs = { workspaceId, url: "https://http2.mlstatic.com/photo.png", license: "ML" };

describe("import_asset_from_url MCP tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores the real dimensions and bytes instead of trusting the caller", async () => {
    const { dependencies, puts } = await setup();
    const result = await importAssetFromUrlTool(importArgs, actorId, dependencies);
    expect(result.ok).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ mimeType: "image/png", width: 500, height: 400 });
  });

  it("letterboxes the photo onto the requested channel canvas", async () => {
    const { dependencies, puts } = await setup();
    await importAssetFromUrlTool(
      { ...importArgs, width: 1080, height: 1350 },
      actorId,
      dependencies,
    );
    const stored = await sharp(puts[0]?.bytes).metadata();
    expect([stored.format, stored.width, stored.height]).toEqual(["jpeg", 1080, 1350]);
    expect(puts[0]).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1350 });
  });

  it("tags a logo with its role and answers a stable public URL", async () => {
    const { dependencies, created } = await setup();
    const result = await importAssetFromUrlTool(
      { ...importArgs, role: "logo", label: "Casa", nicheId: workspaceId },
      actorId,
      { ...dependencies, publicApiUrl: "https://mcp.example.com/" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { asset: Asset; publicUrl?: string };
    expect(created[0]?.metadata).toEqual({ role: "logo", label: "Casa", nicheId: workspaceId });
    expect(value.publicUrl).toBe(
      `https://mcp.example.com/v1/public/workspaces/${workspaceId}/assets/${created[0]?.id}`,
    );
  });

  it("rejects a canvas with only one side", async () => {
    const { dependencies } = await setup();
    await expect(
      importAssetFromUrlTool({ ...importArgs, width: 1080 }, actorId, dependencies),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
