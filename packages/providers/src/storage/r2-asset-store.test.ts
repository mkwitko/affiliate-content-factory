import { describe, expect, it } from "vitest";
import { R2AssetStore, type R2SigningClient } from "./r2-asset-store.js";

describe("R2AssetStore", () => {
  it("returns short-lived signed targets without exposing storage credentials", async () => {
    const calls: string[] = [];
    const client: R2SigningClient = {
      createUploadUrl: async (input) => {
        calls.push(`upload:${input.key}:${input.metadata.width}x${input.metadata.height}`);
        return "https://signed.example/upload";
      },
      createDownloadUrl: async (input) => {
        calls.push(`download:${input.key}`);
        return "https://signed.example/download";
      },
      putObject: async (input) => {
        calls.push(`put:${input.key}:${input.contentType}:${input.body.length}`);
      },
      deleteObject: async (key) => {
        calls.push(`delete:${key}`);
      },
      verifyObject: async ({ key }) => {
        calls.push(`verify:${key}`);
        return { checksum: "checksum-1", mimeType: "image/jpeg", width: 1080, height: 1080 };
      },
    };
    const store = new R2AssetStore(client, "private-bucket", 300);

    await expect(
      store.createUpload({
        workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d" as never,
        assetId: "asset-1",
        mimeType: "image/jpeg",
        checksum: "checksum-1",
        width: 1080,
        height: 1080,
      }),
    ).resolves.toEqual({
      method: "PUT",
      url: "https://signed.example/upload",
      headers: {
        "content-type": "image/jpeg",
        "x-amz-meta-checksum": "checksum-1",
        "x-amz-meta-width": "1080",
        "x-amz-meta-height": "1080",
      },
    });
    await expect(
      store.createDownload({
        workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d" as never,
        assetId: "asset-1",
      }),
    ).resolves.toEqual({ method: "GET", url: "https://signed.example/download" });
    await expect(
      store.verifyUpload({
        workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d" as never,
        assetId: "asset-1",
      }),
    ).resolves.toEqual({
      checksum: "checksum-1",
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
    });
    await store.putObject({
      workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d" as never,
      assetId: "asset-1",
      mimeType: "image/jpeg",
      checksum: "checksum-1",
      width: 1080,
      height: 1080,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(calls).toContain(
      "put:workspaces/0d7702aa-a69d-4f49-842a-c1a13e72160d/assets/asset-1:image/jpeg:3",
    );
    expect(JSON.stringify(calls)).not.toContain("private-bucket");
  });
});
