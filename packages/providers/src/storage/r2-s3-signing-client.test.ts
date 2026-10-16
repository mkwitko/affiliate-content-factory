import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createR2S3SigningClient } from "./r2-s3-signing-client.js";

const configuration = {
  accountId: "account-1",
  accessKeyId: "access-key-1",
  secretAccessKey: "secret-key-1",
  bucketName: "private-bucket",
};

const oneByOnePng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const oneByOnePngChecksum = `sha256:${createHash("sha256").update(oneByOnePng).digest("hex")}`;

describe("createR2S3SigningClient", () => {
  it("verifies signed metadata against the uploaded image bytes", async () => {
    const client = new S3Client({ region: "auto" });
    vi.spyOn(client, "send").mockResolvedValue({
      Body: { transformToByteArray: async () => oneByOnePng },
      ContentLength: oneByOnePng.byteLength,
      ContentType: "image/png",
      Metadata: { checksum: oneByOnePngChecksum, width: "1", height: "1" },
    } as never);

    await expect(
      createR2S3SigningClient(configuration, client).verifyObject({ key: "asset-key" }),
    ).resolves.toEqual({
      checksum: oneByOnePngChecksum,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("rejects objects without the metadata required for activation", async () => {
    const client = new S3Client({ region: "auto" });
    vi.spyOn(client, "send").mockResolvedValue({
      Body: { transformToByteArray: async () => oneByOnePng },
      ContentType: "image/png",
      Metadata: { checksum: oneByOnePngChecksum },
    } as never);

    await expect(
      createR2S3SigningClient(configuration, client).verifyObject({ key: "asset-key" }),
    ).rejects.toThrow("Stored asset metadata");
  });
});
