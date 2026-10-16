import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { McpDependencies } from "../server.js";
import { setAssetRightsTool } from "./set-asset-rights.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const setup = (asset: Partial<Asset>) => {
  const updateRights = vi.fn(async () => ({ id: "a1", commercialUse: true }));
  const deps = {
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner" as const,
        status: "active" as const,
      }),
    },
    assetRepository: {
      findForWorkspace: async () => ({
        id: "a1",
        workspaceId,
        provenance: "generated",
        creator: "agnes:video-model",
        ...asset,
      }),
      updateRights,
    },
  } as unknown as McpDependencies;
  const run = (creator?: string) =>
    setAssetRightsTool(
      {
        workspaceId,
        assetId: "a1",
        commercialUse: true,
        license: "x",
        ...(creator ? { creator } : {}),
      },
      actorId,
      deps,
    );
  return { run, updateRights };
};

describe("set_asset_rights G0 bypass", () => {
  it("refuses stage-cached artifacts", async () => {
    const { run, updateRights } = setup({
      metadata: { role: "stage_artifact", stage: "scene_clip" },
    });
    expect(await run("money-maker:procedural-scene-v1")).toEqual({
      ok: false,
      error: "INVALID_CONTENT",
    });
    expect(updateRights).not.toHaveBeenCalled();
  });
  it("uses the stored creator for generated assets, never the input one", async () => {
    const { run, updateRights } = setup({});
    expect(await run("money-maker:procedural-scene-v1")).toEqual({
      ok: false,
      error: "INVALID_CONTENT",
    });
    expect(updateRights).not.toHaveBeenCalled();
  });
});
