import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { McpDependencies } from "../server.js";
import { importAssetFromFileTool } from "./import-asset-from-file.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const setup = async () => {
  const slide = await sharp({
    create: { width: 1024, height: 1536, channels: 3, background: "#00aa55" },
  })
    .png()
    .toBuffer();
  const fetcher = vi.fn(
    async () => new Response(slide, { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetcher);
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
  return { dependencies, puts, created, fetcher };
};

const file = {
  download_url: "https://files.oaiusercontent.com/file-abc?sig=1",
  file_id: "file-abc",
  mime_type: "image/png",
  file_name: "slide-1.png",
};
const importArgs = { workspaceId, file, source: "generated", license: "Generated in ChatGPT" };

describe("import_asset_from_file MCP tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fills the channel canvas with a generated slide and records its provenance", async () => {
    const { dependencies, puts, created, fetcher } = await setup();
    const result = await importAssetFromFileTool(
      { ...importArgs, width: 1080, height: 1350 },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(new URL(file.download_url), expect.anything());
    const stored = await sharp(puts[0]?.bytes).metadata();
    expect([stored.width, stored.height]).toEqual([1080, 1350]);
    // Cover, not letterbox: the corner keeps the slide colour instead of a white bar.
    const { data } = await sharp(puts[0]?.bytes)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeLessThan(40);
    expect(created[0]).toMatchObject({ provenance: "generated", license: "Generated in ChatGPT" });
  });

  it("rejects a file reference without a file id", async () => {
    const { dependencies, fetcher } = await setup();
    const result = await importAssetFromFileTool(
      { ...importArgs, file: { download_url: file.download_url } },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a download url that is not public https", async () => {
    const { dependencies, fetcher } = await setup();
    const result = await importAssetFromFileTool(
      { ...importArgs, file: { ...file, download_url: "http://127.0.0.1/slide.png" } },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("adds a painted explainer background to the niche bank and requires its setting and style", async () => {
    const { dependencies, created } = await setup();
    const nicheId = "f11f02f5-f88f-42eb-8869-9f9f59e8c5c5";
    const background = {
      ...importArgs,
      source: "operator_upload",
      license: "owned",
      commercialUse: true,
      role: "explainer_background",
      nicheId,
      setting: "kitchen",
      style: "flat_cartoon",
    };
    expect((await importAssetFromFileTool(background, actorId, dependencies)).ok).toBe(true);
    expect(created[0]).toMatchObject({
      commercialUse: true,
      metadata: {
        role: "explainer_background",
        nicheId,
        setting: "kitchen",
        style: "flat_cartoon",
        sceneKey: `${nicheId}:explainer:kitchen:flat_cartoon:v1`,
        usageCount: 0,
      },
    });
    const { style: _style, ...withoutStyle } = background;
    expect(await importAssetFromFileTool(withoutStyle, actorId, dependencies)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
});
