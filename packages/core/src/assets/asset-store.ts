import type { WorkspaceId } from "@money-maker/contracts";

export type AssetUploadTarget = Readonly<{
  method: "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
}>;
export type AssetDownloadTarget = Readonly<{ method: "GET"; url: string }>;
export type VerifiedAssetUpload = Readonly<{
  checksum: string;
  mimeType: string;
  width: number;
  height: number;
}>;

export interface AssetStore {
  createUpload(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    mimeType: string;
    checksum: string;
    width: number;
    height: number;
  }): Promise<AssetUploadTarget>;
  createDownload(input: {
    workspaceId: WorkspaceId;
    assetId: string;
  }): Promise<AssetDownloadTarget>;
  verifyUpload(input: { workspaceId: WorkspaceId; assetId: string }): Promise<VerifiedAssetUpload>;
  putObject(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    mimeType: string;
    checksum: string;
    width: number;
    height: number;
    bytes: Uint8Array;
  }): Promise<void>;
  deleteObject(input: { workspaceId: WorkspaceId; assetId: string }): Promise<void>;
}
