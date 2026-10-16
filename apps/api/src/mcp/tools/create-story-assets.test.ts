import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { StoryImageComposer } from "@money-maker/core/assets/story-image-composer";
import type { McpDependencies } from "../server.js";
import { createStoryAssetsTool } from "./create-story-assets.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const sourceAsset: Asset = {
  id: "slide-1",
  workspaceId,
  objectKey: "hidden",
  checksum: "x",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  provenance: "generated",
  commercialUse: null,
  license: "ai",
  state: "active",
};

const setup = async (composeImpl?: StoryImageComposer["compose"]) => {
  const photo = await sharp({
    create: { width: 1080, height: 1350, channels: 3, background: "#00ff00" },
  })
    .jpeg()
    .toBuffer();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(photo, { headers: { "content-type": "image/jpeg" } })),
  );
  const puts: Parameters<AssetStore["putObject"]>[0][] = [];
  const created: Asset[] = [];
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner" as const,
        status: "active" as const,
      }),
    } as unknown as McpDependencies["workspaces"],
    assetRepository: {
      findForWorkspace: async () => sourceAsset,
      create: async (asset: Asset) => {
        created.push(asset);
        return asset;
      },
      updateState: async ({ state }: { state: Asset["state"] }) => ({ state }) as unknown as Asset,
    } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    assetStore: {
      createDownload: async () => ({
        method: "GET" as const,
        url: "https://cdn.example/slide.jpg",
      }),
      putObject: async (input: Parameters<AssetStore["putObject"]>[0]) => {
        puts.push(input);
      },
    } as unknown as AssetStore,
    storyImageComposer: {
      compose:
        composeImpl ??
        (async (input) => ({
          bytes: new Uint8Array([...input.bytes].slice(0, 4)),
          mimeType: "image/jpeg" as const,
          width: 1080,
          height: 1920,
        })),
    },
  };
  return { dependencies, puts, created };
};

const input = { workspaceId, assetIds: ["slide-1"] };

describe("create_story_assets MCP tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("composites the source slide and stores a new 1080x1920 asset", async () => {
    const { dependencies, puts, created } = await setup();
    const result = await createStoryAssetsTool(input, actorId, dependencies);
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ width: 1080, height: 1920, provenance: "generated" });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1920 });
    if (result.ok) expect(result.value).toEqual({ assetIds: [created[0]?.id] });
  });

  it("keeps slide order across multiple assets", async () => {
    const { dependencies, created } = await setup();
    const result = await createStoryAssetsTool(
      { workspaceId, assetIds: ["slide-1", "slide-1"] },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(2);
    if (result.ok) expect(result.value).toEqual({ assetIds: created.map((asset) => asset.id) });
  });

  it("rejects invalid arguments", async () => {
    const { dependencies } = await setup();
    const result = await createStoryAssetsTool({ workspaceId }, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const { dependencies } = await setup();
    const result = await createStoryAssetsTool(input, actorId, {
      ...dependencies,
      workspaces: { findMembership: async () => null } as unknown as McpDependencies["workspaces"],
    });
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("returns CONTENT_NOT_FOUND for a missing or inactive source asset", async () => {
    const { dependencies } = await setup();
    const result = await createStoryAssetsTool(input, actorId, {
      ...dependencies,
      assetRepository: {
        findForWorkspace: async () => null,
      } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    });
    expect(result).toEqual({ ok: false, error: "CONTENT_NOT_FOUND" });
  });

  it("returns INVALID_CONTENT when the composer fails", async () => {
    const { dependencies } = await setup(async () => {
      throw new Error("compose_failed");
    });
    const result = await createStoryAssetsTool(input, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
  });
});
