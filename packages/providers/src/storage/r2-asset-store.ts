import type {
  AssetDownloadTarget,
  AssetStore,
  AssetUploadTarget,
  VerifiedAssetUpload,
} from "@money-maker/core/assets/asset-store";
import type { WorkspaceId } from "@money-maker/contracts";

export type R2SigningClient = Readonly<{
  createUploadUrl(input: {
    key: string;
    contentType: string;
    metadata: Readonly<Record<string, string>>;
    expiresInSeconds: number;
  }): Promise<string>;
  createDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  putObject(input: {
    key: string;
    contentType: string;
    metadata: Readonly<Record<string, string>>;
    body: Uint8Array;
  }): Promise<void>;
  deleteObject(key: string): Promise<void>;
  verifyObject(input: { key: string }): Promise<VerifiedAssetUpload>;
}>;

const objectKey = (workspaceId: WorkspaceId, assetId: string): string =>
  `workspaces/${workspaceId}/assets/${assetId}`;

export class R2AssetStore implements AssetStore {
  public constructor(
    private readonly client: R2SigningClient,
    bucketName: string,
    private readonly expiresInSeconds: number,
  ) {
    if (bucketName.trim().length === 0) throw new Error("R2 bucket name is required");
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("R2 signed URL expiry must be positive");
    }
  }

  public async createUpload(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    mimeType: string;
    checksum: string;
    width: number;
    height: number;
  }): Promise<AssetUploadTarget> {
    return {
      method: "PUT",
      url: await this.client.createUploadUrl({
        key: objectKey(input.workspaceId, input.assetId),
        contentType: input.mimeType,
        metadata: {
          checksum: input.checksum,
          width: String(input.width),
          height: String(input.height),
        },
        expiresInSeconds: this.expiresInSeconds,
      }),
      headers: {
        "content-type": input.mimeType,
        "x-amz-meta-checksum": input.checksum,
        "x-amz-meta-width": String(input.width),
        "x-amz-meta-height": String(input.height),
      },
    };
  }

  public async createDownload(input: {
    workspaceId: WorkspaceId;
    assetId: string;
  }): Promise<AssetDownloadTarget> {
    return {
      method: "GET",
      url: await this.client.createDownloadUrl({
        key: objectKey(input.workspaceId, input.assetId),
        expiresInSeconds: this.expiresInSeconds,
      }),
    };
  }

  public putObject(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    mimeType: string;
    checksum: string;
    width: number;
    height: number;
    bytes: Uint8Array;
  }): Promise<void> {
    return this.client.putObject({
      key: objectKey(input.workspaceId, input.assetId),
      contentType: input.mimeType,
      metadata: {
        checksum: input.checksum,
        width: String(input.width),
        height: String(input.height),
      },
      body: input.bytes,
    });
  }

  public deleteObject(input: { workspaceId: WorkspaceId; assetId: string }): Promise<void> {
    return this.client.deleteObject(objectKey(input.workspaceId, input.assetId));
  }

  public verifyUpload(input: {
    workspaceId: WorkspaceId;
    assetId: string;
  }): Promise<VerifiedAssetUpload> {
    return this.client.verifyObject({ key: objectKey(input.workspaceId, input.assetId) });
  }
}
