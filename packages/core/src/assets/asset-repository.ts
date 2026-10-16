import type { WorkspaceId } from "@money-maker/contracts";
import type { Asset } from "./asset.js";

export interface AssetRepository {
  create(asset: Asset): Promise<Asset>;
  findByMetadata(input: {
    workspaceId: WorkspaceId;
    role: string;
    key: string;
    value: string;
  }): Promise<Asset | null>;
  /** Active assets unless `state` asks for another one. */
  listByMetadata?(input: {
    workspaceId: WorkspaceId;
    role: string;
    key: string;
    value: string;
    state?: Asset["state"];
  }): Promise<readonly Asset[]>;
  updateMetadata?(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    patch: Readonly<Record<string, unknown>>;
  }): Promise<Asset | null>;
  /** Active assets unless `state` asks for another one. */
  listForWorkspace?(workspaceId: WorkspaceId, state?: Asset["state"]): Promise<readonly Asset[]>;
  findForWorkspace(input: { workspaceId: WorkspaceId; assetId: string }): Promise<Asset | null>;
  updateState(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    state: Asset["state"];
  }): Promise<Asset | null>;
  completeRenderedAsset(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    checksum: string;
    byteSize: number;
    durationMs: number;
    width: number;
    height: number;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<Asset | null>;
  updateRights?(input: {
    workspaceId: WorkspaceId;
    assetId: string;
    commercialUse: boolean | null;
    license: string;
    sourceUrl?: string | null;
    creator?: string | null;
  }): Promise<Asset | null>;
}
