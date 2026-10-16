import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { createAsset } from "./asset.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

describe("asset domain", () => {
  it("rejects unsupported media types", () => {
    expect(
      createAsset({
        id: "asset-1",
        workspaceId,
        mimeType: "application/pdf",
        checksum: "sha256:abc",
        width: 100,
        height: 100,
        provenance: "operator_upload",
        license: "operator-confirmed",
      }),
    ).toEqual({ ok: false, code: "unsupported_media_type" });
  });

  it("creates a workspace-prefixed object key with media metadata", () => {
    const result = createAsset({
      id: "asset-1",
      workspaceId,
      mimeType: "image/jpeg",
      checksum: "sha256:abc",
      width: 1080,
      height: 1080,
      provenance: "operator_upload",
      license: "operator-confirmed",
    });

    expect(result).toMatchObject({
      ok: true,
      asset: {
        id: "asset-1",
        workspaceId,
        objectKey: `workspaces/${workspaceId}/assets/asset-1`,
        width: 1080,
        height: 1080,
      },
    });
  });

  it("accepts a rendered reel video", () => {
    const result = createAsset({
      id: "asset-2",
      workspaceId,
      mimeType: "video/mp4",
      checksum: "sha256:def",
      width: 1080,
      height: 1920,
      provenance: "generated",
      license: "Generated from approved carousel slides",
    });

    expect(result).toMatchObject({ ok: true, asset: { mimeType: "video/mp4" } });
  });
});
